-- ============================================================
-- DEVICES — komentaras perkeliamas iš device_stock (per LOKACIJĄ) į devices
-- (per visą PRIETAISĄ/MODELĮ) lygmenį.
--
-- Pakeista, palyginti su pradiniu migrate_add_devices.sql sprendimu: ten
-- komentaras buvo saugomas device_stock lygmenyje (kiekvienai lokacijai
-- atskirai), nes originaliame Excel jis dažnai apibūdindavo konkretaus
-- likučio būklę. Vartotojo sprendimas — komentaras turi būti VIENAS visam
-- prietaisui, nepriklausomai nuo to, kiek jis turi lokacijų.
--
-- device_stock.notes stulpelis PALIEKAMAS DB (nenaudojamas front-end pusėje
-- nuo šiol) — saugiau nei jį trinti, jei jame jau yra importuotų duomenų.
-- ============================================================

alter table public.devices
  add column if not exists notes text;

-- Perrašo migrate_add_devices.sql import_devices() versiją — Excel
-- "Komentaras" stulpelis dabar patenka į devices.notes (upsert pagal IAN,
-- naujausia importo reikšmė laimi — ta pati taisyklė kaip name/manufacturer),
-- o NE į device_stock.notes.
create or replace function public.import_devices(rows jsonb, p_clear_existing boolean default false)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  r              jsonb;
  v_ian          text;
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

    -- coalesce visuose trijuose laukuose — jei pakartotinio importo eilutėje
    -- (pvz. antra to paties IAN lokacijos eilutė) laukas tuščias, paliekama
    -- jau esama reikšmė, o ne perrašoma NULL (žr. pastabą prie notes žemiau).
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

    insert into public.device_stock (device_id, location, quantity)
    values (
      v_device_id,
      v_location,
      coalesce((r->>'quantity')::integer, 0)
    )
    on conflict (device_id, location) do update
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
