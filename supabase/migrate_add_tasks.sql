-- Paleisti Supabase Dashboard → SQL Editor
-- PALEIDIMO TVARKA: nepriklauso nuo kitų migracijų (naudoja tik
-- public.set_updated_at() iš pradinės schemos).
--
-- Darbų sąrašas (/darbai) — asmeniniai priminimai ("atkrauti paletę",
-- "išsiųsti laišką"). Skirtingai nuo kitų modulių, peržiūra NĖRA vieša:
-- darbą mato tik jį sukūręs vartotojas (ir tas, kam jis priskirtas).
-- assigned_to kol kas nenaudojamas UI — paliktas, kad vėliau priskiriant
-- darbus kolegoms nereikėtų keisti lentelės.
-- ------------------------------------------------------------

create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(trim(title)) > 0),
  note        text,
  due_date    date,
  done        boolean not null default false,
  done_at     timestamptz,
  created_by  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  assigned_to uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ⭐ svarbu, žingsniai (papildomi pažymimi punktai) ir rankinė tvarka.
-- Atskirai (add column if not exists), kad migraciją būtų galima paleisti
-- ir ten, kur lentelė jau sukurta be šių stulpelių.
alter table public.tasks
  add column if not exists starred  boolean not null default false,
  -- [{"id": "…", "title": "…", "done": false}, …] — kortelės žingsniai
  add column if not exists steps    jsonb not null default '[]'::jsonb,
  -- rankinė tvarka grupės viduje (tempiant); naujas darbas — sąrašo gale
  add column if not exists position double precision not null default extract(epoch from now());

comment on table public.tasks is 'Darbų sąrašas (/darbai). Matomas tik kūrėjui ir tam, kam priskirta.';

create index if not exists tasks_created_by_done_idx on public.tasks (created_by, done);
create index if not exists tasks_assigned_to_done_idx on public.tasks (assigned_to, done) where assigned_to is not null;

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

-- done_at nustatomas DB pusėje, kad nepriklausytų nuo įrenginio laikrodžio.
create or replace function public.tasks_set_done_at()
returns trigger
language plpgsql
as $$
begin
  if new.done and (tg_op = 'INSERT' or not old.done) then
    new.done_at = now();
  elsif not new.done then
    new.done_at = null;
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_set_done_at on public.tasks;
create trigger tasks_set_done_at
  before insert or update on public.tasks
  for each row execute function public.tasks_set_done_at();

alter table public.tasks enable row level security;

drop policy if exists "tasks_select_own" on public.tasks;
create policy "tasks_select_own" on public.tasks
  for select to authenticated
  using (created_by = auth.uid() or assigned_to = auth.uid());

drop policy if exists "tasks_insert_own" on public.tasks;
create policy "tasks_insert_own" on public.tasks
  for insert to authenticated
  with check (created_by = auth.uid());

drop policy if exists "tasks_update_own" on public.tasks;
create policy "tasks_update_own" on public.tasks
  for update to authenticated
  using (created_by = auth.uid() or assigned_to = auth.uid())
  with check (created_by = auth.uid() or assigned_to = auth.uid());

drop policy if exists "tasks_delete_own" on public.tasks;
create policy "tasks_delete_own" on public.tasks
  for delete to authenticated
  using (created_by = auth.uid());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table public.tasks;
  end if;
end;
$$;
