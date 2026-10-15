-- Paleisti Supabase Dashboard → SQL Editor
-- PALEIDIMO TVARKA: po migrate_add_shipping_tasks.sql.
--
-- Darbų modulis (/darbai) ne tik adminui: adminas vartotojų puslapyje
-- pažymi, kas jį turi (profiles.tasks_enabled). Tik jiems (ir adminams)
-- galima priskirti "Paruošti išsiuntimui" darbą. Patys darbai lieka
-- privatūs — RLS (kūrėjas / kam priskirta) nesikeičia.
-- ------------------------------------------------------------

alter table public.profiles
  add column if not exists tasks_enabled boolean not null default false;

comment on column public.profiles.tasks_enabled is 'Ar vartotojas turi darbų modulį (/darbai). Adminas turi visada.';

-- Kam galima priskirti darbą: adminai + vartotojai su darbų moduliu.
create or replace function public.task_assignees()
returns table (id uuid, username text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.username
  from public.profiles p
  where p.is_admin or p.tasks_enabled
  order by p.username;
$$;

revoke all on function public.task_assignees() from public, anon;
grant execute on function public.task_assignees() to authenticated;

-- Darbo kūrėjų vardai ("Nuo: …" kortelėje). profiles RLS ne adminui rodo tik
-- savo profilį, todėl vardai grąžinami per šią funkciją — tik id ir vardas,
-- tik tų vartotojų, kurie sukūrė arba gavo kviečiančiajam matomą darbą.
create or replace function public.task_people_names(p_ids uuid[])
returns table (id uuid, username text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.username
  from public.profiles p
  where p.id = any(p_ids)
    and exists (
      select 1 from public.tasks t
      where (t.created_by = auth.uid() or t.assigned_to = auth.uid())
        and (t.created_by = p.id or t.assigned_to = p.id)
    );
$$;

revoke all on function public.task_people_names(uuid[]) from public, anon;
grant execute on function public.task_people_names(uuid[]) to authenticated;
