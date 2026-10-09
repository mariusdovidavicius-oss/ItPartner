-- Paleisti Supabase Dashboard → SQL Editor
-- PALEIDIMO TVARKA: po migrate_add_device_warehouses.sql.
--
-- transfer_device_stock() — prietaiso kiekio perkėlimas iš vienos vietos
-- (device_stock eilutės) į kitą: esamą to paties prietaiso vietą ARBA naują
-- (bet kuris sandėlis + lokacija). Bendras prietaiso kiekis nesikeičia, tad
-- tai ne nurašymas — pakanka 'edit' teisės (ta pati, kuri leidžia keisti
-- vietos sandėlį/lokaciją redagavimo lange).
--
-- Atomiška (viena transakcija, šaltinio eilutė užrakinama):
--  * šaltinis sumažinamas; tikslas padidinamas (arba sukuriamas);
--  * perkėlus VISĄ kiekį šaltinis ištrinamas (dvi vietos "susilieja"), o
--    jo dar nenurašyti "Paimta" punktai (device_pickups.picked_stock_id)
--    perkeliami į tikslą, kad finalize_device_pickup() nurašytų iš ten;
--  * perkeliant DALĮ, šaltinyje turi likti bent tiek, kiek jau pažymėta
--    "Paimta" iš šios vietos (kitaip vėlesnis nurašymas nepavyktų).
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

  if p_to_warehouse_id = v_from_wh and v_to_location = v_from_location then
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
  on conflict (device_id, warehouse_id, location) do update
    set quantity = public.device_stock.quantity + excluded.quantity,
        updated_at = now()
  returning id into v_to_stock_id;

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
