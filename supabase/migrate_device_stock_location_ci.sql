-- Paleisti Supabase Dashboard → SQL Editor
-- PALEIDIMO TVARKA: po migrate_add_device_stock_transfer.sql.
--
-- Prietaiso likučio lokacija — kaip priedų (migrate_part_unique_and_transfer.sql):
-- tas pats prietaisas tame pačiame sandėlyje gali turėti TIK vieną eilutę
-- lokacijai, neatsižvelgiant į raidžių dydį ir tarpus kraštuose ("a2" = "A2 ").
-- Anksčiau unikalumas buvo pagal tikslų tekstą (device_stock_device_warehouse_location_unique).
-- Jei DB jau yra tokių "dublikatų", indekso kūrimas nutrūks — surasti juos:
--   select device_id, warehouse_id, lt_lower(trim(location)), count(*)
--     from device_stock group by 1, 2, 3 having count(*) > 1;
--
-- Perrašomos visos funkcijos, kurių ON CONFLICT rėmėsi senuoju apribojimu:
-- undo_device_writeoff(), import_devices(), transfer_device_stock().
-- ------------------------------------------------------------

create unique index if not exists device_stock_device_warehouse_location_ci_unique
  on public.device_stock (device_id, warehouse_id, public.lt_lower(trim(location)));

alter table public.device_stock
  drop constraint if exists device_stock_device_warehouse_location_unique;

-- ------------------------------------------------------------
-- undo_device_writeoff() — tik naujas ON CONFLICT taikinys.
-- ------------------------------------------------------------
create or replace function public.undo_device_writeoff(p_writeoff_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device_id    uuid;
  v_warehouse_id uuid;
  v_location     text;
  v_quantity     integer;
  v_undone       timestamptz;
begin
  if not public.has_device_permission(auth.uid(), 'delete') then
    raise exception 'Neturite teisės atšaukti nurašymo.';
  end if;

  select device_id, warehouse_id, location, quantity, undone_at
    into v_device_id, v_warehouse_id, v_location, v_quantity, v_undone
    from public.device_writeoffs
    where id = p_writeoff_id
    for update;

  if v_location is null then
    raise exception 'Nurašymas nerastas.';
  end if;
  if v_undone is not null then
    raise exception 'Šis nurašymas jau atšauktas.';
  end if;
  if v_device_id is null then
    raise exception 'Prietaisas ištrintas — nurašymo atšaukti nebegalima.';
  end if;
  if v_warehouse_id is null then
    raise exception 'Sandėlis nežinomas (senas įrašas be sandėlio) — nurašymo atšaukti nebegalima.';
  end if;

  insert into public.device_stock (device_id, warehouse_id, location, quantity)
  values (v_device_id, v_warehouse_id, v_location, v_quantity)
  on conflict (device_id, warehouse_id, public.lt_lower(trim(location))) do update
    set quantity = public.device_stock.quantity + excluded.quantity,
        updated_at = now();

  update public.device_writeoffs
    set undone_at = now(), undone_by = auth.uid()
    where id = p_writeoff_id;

  update public.device_pickups
    set writeoff_id = null
    where writeoff_id = p_writeoff_id;
end;
$$;

grant execute on function public.undo_device_writeoff(uuid) to authenticated;

-- ------------------------------------------------------------
-- import_devices() — tik naujas ON CONFLICT taikinys (visa kita identiška
-- migrate_search_lt_fold.sql versijai).
-- ------------------------------------------------------------
create or replace function public.import_devices(rows jsonb, p_clear_existing boolean default false)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  r              jsonb;
  v_ian          text;
  v_warehouse    text;
  v_warehouse_id uuid;
  v_location     text;
  v_device_id    uuid;
  device_count   integer := 0;
  stock_count    integer := 0;
  skipped_count  integer := 0;
begin
  if not public.has_device_permission(auth.uid(), 'import') then
    raise exception 'Neturite prietaisų importo teisės.';
  end if;

  if p_clear_existing then
    if not public.has_device_permission(auth.uid(), 'delete') then
      raise exception 'Norint prieš importą išvalyti esamus duomenis, reikia trynimo teisės.';
    end if;
    delete from public.devices;
  end if;

  for r in select * from jsonb_array_elements(rows)
  loop
    v_ian := nullif(trim(r->>'ian'), '');
    if v_ian is null then
      skipped_count := skipped_count + 1;
      continue;
    end if;

    v_warehouse := nullif(trim(r->>'warehouse'), '');
    v_warehouse_id := null;
    if v_warehouse is not null then
      select id into v_warehouse_id from public.warehouses
        where public.lt_lower(trim(name)) = public.lt_lower(v_warehouse);
    end if;
    if v_warehouse_id is null then
      skipped_count := skipped_count + 1;
      continue;
    end if;

    insert into public.devices (ian, name, manufacturer, notes)
    values (v_ian, nullif(r->>'name', ''), nullif(r->>'manufacturer', ''), nullif(r->>'notes', ''))
    on conflict (ian) do update
      set name = coalesce(excluded.name, public.devices.name),
          manufacturer = coalesce(excluded.manufacturer, public.devices.manufacturer),
          notes = coalesce(excluded.notes, public.devices.notes),
          updated_at = now()
    returning id into v_device_id;

    device_count := device_count + 1;

    v_location := coalesce(nullif(trim(r->>'location'), ''), '-');

    insert into public.device_stock (device_id, warehouse_id, location, quantity)
    values (
      v_device_id,
      v_warehouse_id,
      v_location,
      coalesce((r->>'quantity')::integer, 0)
    )
    on conflict (device_id, warehouse_id, public.lt_lower(trim(location))) do update
      set quantity = excluded.quantity,
          updated_at = now();

    stock_count := stock_count + 1;
  end loop;

  return json_build_object(
    'devices', device_count,
    'stock_rows', stock_count,
    'skipped', skipped_count
  );
end;
$$;

grant execute on function public.import_devices(jsonb, boolean) to authenticated;

-- ------------------------------------------------------------
-- transfer_device_stock() — naujas ON CONFLICT taikinys IR "ta pati vieta"
-- tikrinama be raidžių dydžio: kitaip "A2" → "a2" per ON CONFLICT
-- atnaujintų PAČIĄ šaltinio eilutę, o perkėlus visą kiekį ji būtų ištrinta.
-- ------------------------------------------------------------
create or replace function public.transfer_device_stock(
  p_from_stock_id uuid,
  p_to_warehouse_id uuid,
  p_to_location text,
  p_quantity integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device_id      uuid;
  v_from_wh        uuid;
  v_from_location  text;
  v_from_qty       integer;
  v_to_location    text := coalesce(nullif(trim(p_to_location), ''), '-');
  v_to_stock_id    uuid;
  v_to_wh_name     text;
  v_reserved       integer;
begin
  if not public.has_device_permission(auth.uid(), 'edit') then
    raise exception 'Neturite teisės perkelti prietaisų.';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Perkeliamas kiekis turi būti didesnis už nulį.';
  end if;

  select device_id, warehouse_id, location, quantity
    into v_device_id, v_from_wh, v_from_location, v_from_qty
    from public.device_stock
    where id = p_from_stock_id
    for update;

  if v_device_id is null then
    raise exception 'Likutis nerastas.';
  end if;
  if p_quantity > v_from_qty then
    raise exception 'Perkeliamas kiekis (%) negali viršyti turimo likučio (%).', p_quantity, v_from_qty;
  end if;

  select name into v_to_wh_name from public.warehouses where id = p_to_warehouse_id;
  if v_to_wh_name is null then
    raise exception 'Sandėlis nerastas.';
  end if;

  if p_to_warehouse_id = v_from_wh
     and public.lt_lower(v_to_location) = public.lt_lower(trim(v_from_location)) then
    raise exception 'Perkelti į tą pačią vietą negalima.';
  end if;

  select coalesce(sum(quantity), 0) into v_reserved
    from public.device_pickups
    where picked_stock_id = p_from_stock_id and writeoff_id is null;

  if p_quantity < v_from_qty and v_from_qty - p_quantity < v_reserved then
    raise exception 'Iš šios vietos jau pažymėta „Paimta“ % vnt. — joje turi likti bent tiek (galima perkelti daugiausia % vnt. arba visą kiekį).',
      v_reserved, greatest(v_from_qty - v_reserved, 0);
  end if;

  insert into public.device_stock (device_id, warehouse_id, location, quantity)
  values (v_device_id, p_to_warehouse_id, v_to_location, p_quantity)
  on conflict (device_id, warehouse_id, public.lt_lower(trim(location))) do update
    set quantity = public.device_stock.quantity + excluded.quantity,
        updated_at = now()
  returning id, location into v_to_stock_id, v_to_location;

  if p_quantity = v_from_qty then
    update public.device_pickups
      set picked_stock_id = v_to_stock_id,
          picked_location = v_to_location,
          picked_warehouse_name = v_to_wh_name
      where picked_stock_id = p_from_stock_id and writeoff_id is null;

    delete from public.device_stock where id = p_from_stock_id;
  else
    update public.device_stock
      set quantity = quantity - p_quantity
      where id = p_from_stock_id;
  end if;

  return v_to_stock_id;
end;
$$;

revoke all on function public.transfer_device_stock(uuid, uuid, text, integer) from public, anon;
grant execute on function public.transfer_device_stock(uuid, uuid, text, integer) to authenticated;
