-- Paleisti Supabase Dashboard → SQL Editor
-- Individualus min. likučio slenkstis kiekvienam prietaisui — ta pati
-- logika, kaip parts.min_quantity (žr. migrate_parts_min_quantity.sql):
-- kai NULL, naudojama numatytoji reikšmė (3).
--
-- Skirtingai nuo parts (kur quantity yra tame pačiame stulpelyje, tad
-- stock_level galėjo būti "generated always as" stulpelis TIESIOG parts
-- lentelėje), prietaiso kiekis yra PER LOKACIJĄ (device_stock, kita
-- lentelė) — mažo likučio sąvoka taikoma BENDRAM (visų lokacijų sumos)
-- kiekiui, tad stock_level SKAIČIUOJAMAS device_totals VIEW viduje, ne
-- stored stulpelyje devices lentelėje (generated column negali remtis
-- kitos lentelės duomenimis).

alter table public.devices
  add column if not exists min_quantity integer;

alter table public.devices
  drop constraint if exists devices_min_quantity_check;
alter table public.devices
  add constraint devices_min_quantity_check check (min_quantity is null or min_quantity >= 0);

-- PASTABA: CREATE OR REPLACE VIEW neleidžia pakeisti esamų stulpelių
-- POZICIJOS/pavadinimo — naujus stulpelius (min_quantity, stock_level)
-- galima pridėti TIK gale, po jau esančių (id, ian, name, manufacturer,
-- total_quantity, location_count), kitaip PostgreSQL bando "pervadinti"
-- stulpelį pagal poziciją ir meta klaidą (42P16).
create or replace view public.device_totals
with (security_invoker = true)
as
select
  d.id,
  d.ian,
  d.name,
  d.manufacturer,
  coalesce(sum(ds.quantity), 0)::integer as total_quantity,
  count(ds.id)::integer as location_count,
  d.min_quantity,
  case
    when coalesce(sum(ds.quantity), 0) <= 0 then 'out'
    when coalesce(sum(ds.quantity), 0) <= coalesce(d.min_quantity, 3) then 'low'
    else 'ok'
  end as stock_level
from public.devices d
left join public.device_stock ds on ds.device_id = d.id
group by d.id, d.ian, d.name, d.manufacturer, d.min_quantity;

comment on view public.device_totals is 'Kiekvieno prietaiso bendras kiekis, susumuotas per visas lokacijas, + mažo likučio būsena (stock_level: out/low/ok, pagal min_quantity arba numatytą 3). security_invoker=true — vykdoma užklausėjo teisėmis, todėl paveldi devices/device_stock RLS.';
