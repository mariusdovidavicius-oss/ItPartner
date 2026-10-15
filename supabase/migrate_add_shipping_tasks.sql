-- Paleisti Supabase Dashboard → SQL Editor
-- PALEIDIMO TVARKA: po migrate_add_tasks.sql ir migrate_parts_split_stock.sql.
--
-- "Paruošti išsiuntimui" — vadybininkė prie priedo (/priedai) pažymi, kad jį
-- reikia atkrauti ir paruošti išsiuntimui (e-parduotuvės užsakymas). Sukuriamas
-- įprastas darbas (tasks), priskirtas sandėlininkui (assigned_to), susietas su
-- priedu — kortelėje matosi priedas, kiekis, užsakymo nr. ir vietos.
-- Likutis kol kas NEnurašomas automatiškai.
-- ------------------------------------------------------------

alter table public.tasks
  add column if not exists part_id   uuid references public.parts (id) on delete set null,
  add column if not exists quantity  integer,
  add column if not exists order_ref text;

alter table public.tasks drop constraint if exists tasks_quantity_check;
alter table public.tasks
  add constraint tasks_quantity_check check (quantity is null or quantity > 0);

create index if not exists tasks_part_id_idx on public.tasks (part_id) where part_id is not null;

-- Priskirtą darbą gali ištrinti (atšaukti) ir tas, kam jis priskirtas —
-- kitaip sandėlininko "Ištrinti" tyliai nieko nedarytų (RLS filtruoja 0 eilučių).
drop policy if exists "tasks_delete_own" on public.tasks;
create policy "tasks_delete_own" on public.tasks
  for delete to authenticated
  using (created_by = auth.uid() or assigned_to = auth.uid());

-- Kam galima priskirti išsiuntimo darbą. profiles RLS ne adminui rodo tik
-- savo profilį, todėl sąrašas grąžinamas per security definer funkciją —
-- tik id ir vardas, tik adminai (sandėlininkas).
create or replace function public.task_assignees()
returns table (id uuid, username text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.username
  from public.profiles p
  where p.is_admin
  order by p.username;
$$;

revoke all on function public.task_assignees() from public, anon;
grant execute on function public.task_assignees() to authenticated;
