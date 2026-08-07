-- Paleisti Supabase Dashboard → SQL Editor
-- Leidžia trinti TUŠČIAS (0 vnt.) paletes tiesiai skenavimo puslapyje ir
-- tvarkingai sutvarko tos paskirties (destination) numeravimo skaitliuką
-- "pallet_number_counters" (žr. migrate_dynamic_destination.sql).
--
-- v2 PATAISYMAS: ankstesnė versija skaitliuką sumažindavo -1 TIK jei jis
-- tiksliai sutapo su trinamos paletės numeriu ("current_number = old.number").
-- Jei skaitliukas ir realūs duomenys bent kartą išsiderindavo (pvz. dėl bet
-- kokios ankstesnės neatitikties), ta sąlyga tyliai neatitikdavo ir
-- skaitliukas likdavo "įstrigęs" nepakeistas, kad ir ką vėliau ištrintum —
-- tai ir buvo praneštos klaidos priežastis.
--
-- Dabar vietoj sąlyginio "-1" TIESIOGIAI PERSKAIČIUOJAMAS tikras maksimalus
-- numeris tarp likusių, dar neišsiųstų (shipment_id is null) tos paskirties
-- paletžų, ir juo perrašomas skaitliukas. Tai duoda tą patį rezultatą
-- įprastu atveju (trinant paskutinę paletę — skaitliukas sumažėja), bet
-- papildomai savaime pasitaiso, jei anksčiau atsirado bet kokia neatitiktis.
-- Šis skriptas idempotentiškas (CREATE OR REPLACE / DROP TRIGGER IF EXISTS) —
-- saugu paleisti pakartotinai net jei v1 versija jau buvo paleista.
--
-- Pasirinktas BEFORE DELETE trigeris, o ne atskira RPC funkcija: skaitliuko
-- sutvarkymas vyksta DB pusėje, kartu su pačiu DELETE, nepriklausomai nuo
-- to, IŠ KUR paletė trinama (skenavimo puslapio mygtuko, būsimo admin
-- įrankio ar tiesioginio SQL) — tai atitinka jau esamą trigerių pagrįstą
-- numeravimo architektūrą (set_pallet_number, reset_pallet_numbering_on_
-- shipment_sent), o ne prideda atskirą, lengvai apeinamą RPC kelią, kurio
-- privalėtų laikytis kiekvienas būsimas iškvietėjas.

create or replace function public.decrement_pallet_counter_on_delete()
returns trigger as $$
declare
  v_max_remaining integer;
begin
  -- Tikras maksimalus numeris tarp likusių TOS PAČIOS paskirties paletžų,
  -- kurios dar nepriskirtos išsiųstai siuntai (t. y. priklauso dabartiniam
  -- numeravimo ciklui). Trinama paletė (old.id) neįtraukiama.
  select coalesce(max(number), 0)
    into v_max_remaining
    from public.pallets
   where destination = old.destination
     and id <> old.id
     and shipment_id is null;

  update public.pallet_number_counters
     set current_number = v_max_remaining
   where destination = old.destination;

  return old;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists pallets_decrement_counter_on_delete on public.pallets;
create trigger pallets_decrement_counter_on_delete
  before delete on public.pallets
  for each row execute function public.decrement_pallet_counter_on_delete();
