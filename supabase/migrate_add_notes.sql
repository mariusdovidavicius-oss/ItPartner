-- Paleisti Supabase Dashboard → SQL Editor
-- PALEIDIMO TVARKA: po migrate_tasks_access.sql (naudoja public.is_admin()
-- ir public.set_updated_at() iš pradinės schemos).
--
-- Užrašinė (/uzrasai). Užrašas būna:
--   * asmeninis (shared = false) — mato ir keičia tik jį sukūręs;
--   * bendras   (shared = true)  — mato ir keičia visi, kas turi užrašinę.
-- Užrašinę turi adminai ir vartotojai su profiles.notes_enabled (varnelė
-- vartotojų puslapyje). Bendrinti / nebebendrinti gali tik autorius.
-- Trynimas dviem žingsniais: pirma į archyvą (archived_at), iš ten —
-- grąžinti arba ištrinti visam laikui (tik autorius arba adminas).
-- ------------------------------------------------------------

alter table public.profiles
  add column if not exists notes_enabled boolean not null default false;

comment on column public.profiles.notes_enabled is 'Ar vartotojas turi užrašinę (/uzrasai). Adminas turi visada.';

-- Ar prisijungęs vartotojas turi užrašinę (RLS taisyklėms).
create or replace function public.can_use_notes()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.is_admin or p.notes_enabled from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

revoke all on function public.can_use_notes() from public, anon;
grant execute on function public.can_use_notes() to authenticated;

create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default '',
  body        text not null default '',
  color       text check (color in ('yellow', 'green', 'blue', 'red', 'violet')),
  pinned      boolean not null default false,
  shared      boolean not null default false,
  archived_at timestamptz,
  created_by  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  updated_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.notes is 'Užrašinė (/uzrasai): asmeniniai ir bendri užrašai.';

create index if not exists notes_created_by_idx on public.notes (created_by);
create index if not exists notes_shared_idx on public.notes (shared) where shared;

drop trigger if exists notes_set_updated_at on public.notes;
create trigger notes_set_updated_at
  before update on public.notes
  for each row execute function public.set_updated_at();

-- Kas paskutinis keitė (rodoma bendrų užrašų kortelėje) + apsaugos, kurių
-- RLS neišreiškia: autoriaus pakeisti negalima, bendrinimą keičia tik autorius.
create or replace function public.notes_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.created_by is distinct from old.created_by then
      raise exception 'Užrašo autoriaus pakeisti negalima';
    end if;
    if new.shared is distinct from old.shared and old.created_by is distinct from auth.uid() then
      raise exception 'Bendrinimą gali keisti tik užrašo autorius';
    end if;
  end if;
  if auth.uid() is not null then
    new.updated_by = auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists notes_guard on public.notes;
create trigger notes_guard
  before insert or update on public.notes
  for each row execute function public.notes_guard();

alter table public.notes enable row level security;

drop policy if exists "notes_select" on public.notes;
create policy "notes_select" on public.notes
  for select to authenticated
  using (public.can_use_notes() and (created_by = auth.uid() or shared));

drop policy if exists "notes_insert" on public.notes;
create policy "notes_insert" on public.notes
  for insert to authenticated
  with check (public.can_use_notes() and created_by = auth.uid());

drop policy if exists "notes_update" on public.notes;
create policy "notes_update" on public.notes
  for update to authenticated
  using (public.can_use_notes() and (created_by = auth.uid() or shared))
  with check (public.can_use_notes() and (created_by = auth.uid() or shared));

-- Visam laikui — tik iš archyvo, autorius arba adminas.
drop policy if exists "notes_delete" on public.notes;
create policy "notes_delete" on public.notes
  for delete to authenticated
  using (
    public.can_use_notes()
    and archived_at is not null
    and (created_by = auth.uid() or (shared and public.is_admin(auth.uid())))
  );

-- Autorių / paskutinio keitusiojo vardai bendrų užrašų kortelėms. profiles
-- RLS ne adminui rodo tik savo profilį, todėl — per šią funkciją: tik id ir
-- vardas, tik žmonių, susijusių su kviečiančiajam matomu užrašu.
create or replace function public.note_people_names(p_ids uuid[])
returns table (id uuid, username text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.username
  from public.profiles p
  where p.id = any(p_ids)
    and public.can_use_notes()
    and exists (
      select 1 from public.notes n
      where (n.created_by = auth.uid() or n.shared)
        and (n.created_by = p.id or n.updated_by = p.id)
    );
$$;

revoke all on function public.note_people_names(uuid[]) from public, anon;
grant execute on function public.note_people_names(uuid[]) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notes'
  ) then
    alter publication supabase_realtime add table public.notes;
  end if;
end;
$$;
