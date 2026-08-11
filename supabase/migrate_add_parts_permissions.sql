-- Paleisti Supabase Dashboard → SQL Editor
-- Prideda prisijungimą + teisių sistemą TIK priedų (parts) moduliui.
-- Likusios lentelės (items, pallets, shipments, catalog) nekeičiamos —
-- jos lieka pasiekiamos "anon" rolei kaip ir anksčiau.
--
-- Vartotojai neturi el. pašto — prisijungia "ID" (username), kuris front-end
-- pusėje paverčiamas į vidinį "<id>@parts.local" Supabase Auth reikmėms.
-- Naujus vartotojus kuria tik adminas (per /api/create-user serverless
-- funkciją su service_role raktu — žr. README).

-- 1) profiles — po vieną eilutę kiekvienam auth.users vartotojui
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text not null,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.profiles is 'Vieša info apie kiekvieną prisijungusį vartotoją (priedų modulio teisėms).';

-- Naujam auth.users įrašui automatiškai sukuria profiles eilutę.
-- username išgaunamas iš vidinio "<id>@parts.local" formato el. pašto.
create or replace function public.handle_new_parts_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_parts on auth.users;
create trigger on_auth_user_created_parts
  after insert on auth.users
  for each row execute function public.handle_new_parts_user();

-- 2) user_permissions — vartotojas × teisė (view/edit/delete/import).
-- Atskira lentelė (ne stulpeliai), kad ateityje naujas teises būtų galima
-- pridėti be schema pakeitimų. Šis sąrašas turi atitikti src/lib/permissions.js
-- (PERMISSIONS) ir api/create-user.js (VALID_PERMISSIONS) — DB negali jų
-- importuoti, tad keičiant sąrašą, atnaujinti visas tris vietas.
create table if not exists public.user_permissions (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  permission text not null check (permission in ('view', 'edit', 'delete', 'import')),
  granted_at timestamptz not null default now(),
  primary key (user_id, permission)
);

comment on table public.user_permissions is 'Kiekvienam vartotojui suteiktos priedų modulio teisės.';

-- 3) Pagalbinės funkcijos RLS taisyklėms (SECURITY DEFINER, kad išvengtų
-- RLS rekursijos tikrinant profiles/user_permissions iš pačių jų taisyklių).
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = uid), false);
$$;

create or replace function public.has_permission(uid uuid, perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin(uid) or exists (
    select 1 from public.user_permissions where user_id = uid and permission = perm
  );
$$;

grant execute on function public.is_admin(uuid) to authenticated, anon;
grant execute on function public.has_permission(uuid, text) to authenticated, anon;

-- 4) RLS: profiles ir user_permissions
alter table public.profiles enable row level security;
alter table public.user_permissions enable row level security;

drop policy if exists "Vartotojas mato savo profilį, adminas visus" on public.profiles;
create policy "Vartotojas mato savo profilį, adminas visus"
  on public.profiles for select
  to authenticated
  using (id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "Adminas tvarko profilius" on public.profiles;
create policy "Adminas tvarko profilius"
  on public.profiles for update
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

drop policy if exists "Vartotojas mato savo teises, adminas visas" on public.user_permissions;
create policy "Vartotojas mato savo teises, adminas visas"
  on public.user_permissions for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists "Adminas tvarko teises" on public.user_permissions;
create policy "Adminas tvarko teises"
  on public.user_permissions for all
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- 5) RLS: parts — pakeičia seną "visiems viską leidžia" taisyklę
-- (migrate_add_parts.sql) teisėmis pagrįstomis taisyklėmis.
drop policy if exists "Anon and authenticated full access - parts" on public.parts;

create policy "Peržiūra pagal 'view' teisę"
  on public.parts for select
  to authenticated
  using (public.has_permission(auth.uid(), 'view'));

create policy "Kūrimas/redagavimas pagal 'edit' teisę"
  on public.parts for insert
  to authenticated
  with check (public.has_permission(auth.uid(), 'edit'));

create policy "Atnaujinimas pagal 'edit' teisę"
  on public.parts for update
  to authenticated
  using (public.has_permission(auth.uid(), 'edit'))
  with check (public.has_permission(auth.uid(), 'edit'));

create policy "Trynimas pagal 'delete' teisę"
  on public.parts for delete
  to authenticated
  using (public.has_permission(auth.uid(), 'delete'));

-- 6) import_parts RPC — masinis Excel importas atskirai nuo 'edit'/'delete',
-- kad vartotojas su TIK 'import' teise galėtų importuoti, bet negalėtų
-- rankiniu būdu redaguoti/trinti pavienių įrašų. SECURITY DEFINER apeina
-- eilutės lygio RLS (pati funkcija patikrina teisę viduje).
create or replace function public.import_parts(rows jsonb, clear_existing boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer;
begin
  if not public.has_permission(auth.uid(), 'import') then
    raise exception 'Neturite importo teisės.';
  end if;

  if clear_existing then
    if not public.has_permission(auth.uid(), 'delete') then
      raise exception 'Norint prieš importą išvalyti esamus duomenis, reikia trynimo teisės.';
    end if;
    delete from public.parts;
  end if;

  insert into public.parts (location, main_model, part_code, name, quantity, online_store, compatible_models)
  select
    (r->>'location')::integer,
    nullif(r->>'main_model', ''),
    r->>'part_code',
    nullif(r->>'name', ''),
    coalesce((r->>'quantity')::integer, 0),
    coalesce((r->>'online_store')::boolean, false),
    nullif(r->>'compatible_models', '')
  from jsonb_array_elements(rows) as r;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

grant execute on function public.import_parts(jsonb, boolean) to authenticated;
