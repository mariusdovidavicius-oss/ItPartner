-- Paleisti Supabase Dashboard → SQL Editor
-- 1) Paieška be lietuviškų raidžių skirtumų: "sepetys" randa "šepetys" (ir
--    atvirkščiai), neatsižvelgiant į didžiąsias/mažąsias raides.
-- 2) Sandėlių pavadinimai unikalūs NEATSIŽVELGIANT į didžiąsias/mažąsias
--    raides ("Grizzly" ir "grizzly" — tas pats sandėlis), importas juos
--    atitinkamai ir sutapatina.
--
-- Kiekviena ieškoma lentelė gauna sugeneruotą (stored) stulpelį search_text
-- — visų ieškomų laukų "sulankstytą" kopiją. Front-end'as (src/lib/format.js
-- foldLt()) tą pačią transformaciją pritaiko paieškos tekstui ir filtruoja
-- per search_text ILIKE. Abi pusės TURI likti sinchronizuotos — keičiant
-- raidžių sąrašą čia, pakeisti ir foldLt().
-- ------------------------------------------------------------

-- lower() su "C" lokale nekeičia ne-ASCII didžiųjų raidžių, todėl LT
-- didžiosios verčiamos aiškiai per translate().
create or replace function public.lt_lower(t text)
returns text
language sql
immutable
parallel safe
as $$
  select translate(lower(t), 'ĄČĘĖĮŠŲŪŽ', 'ąčęėįšųūž');
$$;

create or replace function public.lt_fold(t text)
returns text
language sql
immutable
parallel safe
as $$
  select translate(public.lt_lower(t), 'ąčęėįšųūž', 'aceeisuuz');
$$;

-- concat_ws() nėra IMMUTABLE, todėl generated stulpeliuose naudojamas
-- coalesce(...) || ' ' || ...
alter table public.devices
  add column if not exists search_text text generated always as (
    public.lt_fold(coalesce(name, '') || ' ' || coalesce(ian, '') || ' ' || coalesce(manufacturer, ''))
  ) stored;

alter table public.parts
  add column if not exists search_text text generated always as (
    public.lt_fold(
      coalesce(part_code, '') || ' ' || coalesce(name, '') || ' ' ||
      coalesce(main_model, '') || ' ' || coalesce(compatible_models, '')
    )
  ) stored;

alter table public.device_writeoffs
  add column if not exists search_text text generated always as (
    public.lt_fold(coalesce(device_name, '') || ' ' || coalesce(device_ian, ''))
  ) stored;

alter table public.items
  add column if not exists search_text text generated always as (
    public.lt_fold(coalesce(ian, '') || ' ' || coalesce(name, ''))
  ) stored;

alter table public.catalog
  add column if not exists search_text text generated always as (
    public.lt_fold(coalesce(name, ''))
  ) stored;

-- ------------------------------------------------------------
-- Sandėliai — unikalumas pagal lt_lower(trim(name)). Jei jau yra dviejų
-- pavadinimų, kurie skiriasi tik raidžių dydžiu, indekso kūrimas nutrūks
-- su aiškia klaida — tada pirma rankiniu būdu sujungti/pervadinti.
-- ------------------------------------------------------------
create unique index if not exists warehouses_name_ci_unique
  on public.warehouses (public.lt_lower(trim(name)));

-- import_devices() — sandėlis randamas neatsižvelgiant į raidžių dydį.
-- Visa kita — identiška migrate_add_device_warehouses.sql versijai.
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
      -- Sandėlis nenurodytas arba nerastas — eilutė praleidžiama (prietaisas
      -- kataloge NEATSIRANDA/neatsinaujina pagal šią eilutę), nes be sandėlio
      -- device_stock eilutės sukurti negalima (NOT NULL).
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
    on conflict (device_id, warehouse_id, location) do update
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
