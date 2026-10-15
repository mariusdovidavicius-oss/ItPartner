-- Paleisti Supabase Dashboard → SQL Editor
-- PALEIDIMO TVARKA: po migrate_add_shipping_tasks.sql ir migrate_parts_split_stock.sql.
--
-- Išsiuntimo darbo užbaigimas su nurašymu: sandėlininkas, atkrovęs priedą,
-- pažymi darbą atliktu ir tuo pačiu nurašo kiekį ("Parduota") iš vienos ar
-- kelių vietų. Kainą už vienetą įrašo vadybininkė (tasks.unit_price), o jei
-- jos nėra — sandėlininkas užbaigdamas. Nurašymai susiejami su darbu
-- (parts_writeoffs.task_id), kad to paties darbo nebūtų galima nurašyti
-- dukart, o grąžinus darbą į neatliktus — atšaukti jo nurašymus.
-- ------------------------------------------------------------

alter table public.tasks
  add column if not exists unit_price numeric(10, 2);

alter table public.tasks drop constraint if exists tasks_unit_price_check;
alter table public.tasks
  add constraint tasks_unit_price_check check (unit_price is null or unit_price > 0);

alter table public.parts_writeoffs
  add column if not exists task_id uuid references public.tasks (id) on delete set null;

create index if not exists parts_writeoffs_task_id_idx on public.parts_writeoffs (task_id) where task_id is not null;

-- p_lines = [{"stock_id": "…", "quantity": 2}, …] — iš kurių vietų nurašoma.
-- Kiekvienai vietai — atskiras nurašymas, kaina = vnt. kaina × kiekis.
-- Tikrinimai kaip writeoff_part() (teisė 'delete', kiekis ≤ likutis).
create or replace function public.complete_ship_task(
  p_task_id    uuid,
  p_lines      jsonb,
  p_unit_price numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task         public.tasks%rowtype;
  v_line         jsonb;
  v_stock_id     uuid;
  v_quantity     integer;
  v_part_id      uuid;
  v_warehouse_id uuid;
  v_location     text;
  v_current_qty  integer;
  v_total        integer := 0;
begin
  if not public.has_permission(auth.uid(), 'delete') then
    raise exception 'Neturite nurašymo teisės.';
  end if;

  select * into v_task from public.tasks where id = p_task_id for update;
  if v_task.id is null or not (v_task.created_by = auth.uid() or v_task.assigned_to = auth.uid()) then
    raise exception 'Darbas nerastas.';
  end if;
  if v_task.part_id is null then
    raise exception 'Darbas nesusietas su priedu.';
  end if;
  if exists (select 1 from public.parts_writeoffs where task_id = p_task_id and undone_at is null) then
    raise exception 'Šis darbas jau nurašytas.';
  end if;
  if p_unit_price is null or p_unit_price <= 0 then
    raise exception 'Įveskite kainą.';
  end if;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_stock_id := (v_line ->> 'stock_id')::uuid;
    v_quantity := (v_line ->> 'quantity')::integer;
    continue when v_quantity is null or v_quantity = 0;
    if v_quantity < 0 then
      raise exception 'Nurašomas kiekis turi būti didesnis už nulį.';
    end if;

    select part_id, warehouse_id, location, quantity
      into v_part_id, v_warehouse_id, v_location, v_current_qty
      from public.part_stock
      where id = v_stock_id
      for update;
    if v_part_id is null or v_part_id <> v_task.part_id then
      raise exception 'Likutis nerastas.';
    end if;
    if v_quantity > v_current_qty then
      raise exception 'Vietoje % yra tik % vnt.', v_location, v_current_qty;
    end if;

    update public.part_stock set quantity = quantity - v_quantity where id = v_stock_id;

    insert into public.parts_writeoffs (part_id, warehouse_id, location, user_id, quantity, reason_type, price, task_id)
    values (v_part_id, v_warehouse_id, v_location, auth.uid(), v_quantity, 'parduota', p_unit_price * v_quantity, p_task_id);

    v_total := v_total + v_quantity;
  end loop;

  if v_total = 0 then
    raise exception 'Nurodykite, iš kurios vietos nurašoma.';
  end if;

  update public.tasks set done = true, unit_price = p_unit_price where id = p_task_id;
end;
$$;

revoke all on function public.complete_ship_task(uuid, jsonb, numeric) from public, anon;
grant execute on function public.complete_ship_task(uuid, jsonb, numeric) to authenticated;

-- Grąžinti darbą į neatliktus ir atšaukti jo nurašymus (kiekis grįžta į
-- tas pačias vietas per undo_writeoff()).
create or replace function public.reopen_ship_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_id   uuid;
begin
  select * into v_task from public.tasks where id = p_task_id for update;
  if v_task.id is null or not (v_task.created_by = auth.uid() or v_task.assigned_to = auth.uid()) then
    raise exception 'Darbas nerastas.';
  end if;

  for v_id in
    select id from public.parts_writeoffs where task_id = p_task_id and undone_at is null
  loop
    perform public.undo_writeoff(v_id);
  end loop;

  update public.tasks set done = false where id = p_task_id;
end;
$$;

revoke all on function public.reopen_ship_task(uuid) from public, anon;
grant execute on function public.reopen_ship_task(uuid) to authenticated;
