-- Paleisti Supabase Dashboard → SQL Editor
--
-- Problema: dabartinis skaitliukas (pallet_number_counters) TIK didėja ir
-- atsistato ties "ready" pažymėjimu — jei pažymima TIK DALIS "Laukia
-- paruošimo" (closed) paletžų kaip "ready" (pvz. iš 1,2,3 tik "2"), likusiame
-- sąraše lieka spraga ("1, 3"), o skaitliukas tos spragos "nemato" ir naujai
-- paletei vis tiek duoda tęstinį (4, 5...) numerį, o ne užpildo spragą.
--
-- Sprendimas: numeris nebeskaičiuojamas iš atskiro skaitliuko, o RANDAMAS
-- GYVAI kiekvieną kartą kuriant naują paletę — ieškoma mažiausio trūkstamo
-- skaičiaus tarp esamų "Laukia paruošimo" (open/closed, dar nepriskirtų
-- shipment'ui) paletžų tai paskirčiai. Jei tokių nėra nė vienos — pradedama
-- nuo 1.
--
-- Kadangi numeris dabar visada apskaičiuojamas iš TIKROS, esamos būklės (ne
-- iš atskiro, laikui bėgant išsiderinančio skaitliuko), šie mechanizmai
-- tampa NEBEREIKALINGI ir PAŠALINAMI:
--   - pallet_number_counters lentelė
--   - reset_pallet_numbering_on_ready() trigeris (skaitliuko atstatymas
--     ties "ready" pažymėjimu — dabar nereikalingas, nes "gyva" paieška
--     pati automatiškai "mato", kai "Laukia paruošimo" sąrašas ištuštėja)
--   - decrement_pallet_counter_on_delete() trigeris (skaitliuko korekcija
--     trynant tuščią paletę — dabar nereikalinga, nes ištrintos paletės
--     numeris tiesiog taps "matoma" spraga sekantį kartą)
--
-- NELIEČIAMA: pallet_ready_counters / assign_pallet_ready_position /
-- reset_pallet_ready_position_on_sent — tai ATSKIRA sistema "ready" eilės
-- pozicijai (žr. migrate_ready_position_renumbering.sql), su šia paletžų
-- numeravimo logika nesusijusi.

-- ------------------------------------------------------------
-- 1) Pašalinami dabar nebereikalingi trigeriai/funkcijos
-- ------------------------------------------------------------
drop trigger if exists pallets_decrement_counter_on_delete on public.pallets;
drop function if exists public.decrement_pallet_counter_on_delete();

drop trigger if exists pallets_reset_numbering_on_ready on public.pallets;
drop function if exists public.reset_pallet_numbering_on_ready();

-- ------------------------------------------------------------
-- 2) Naujas set_pallet_number() — spragos paieška "gyvai"
-- ------------------------------------------------------------
create or replace function public.set_pallet_number()
returns trigger as $$
declare
  v_number integer;
begin
  if new.number is null then
    select coalesce(min(t.n), 1)
      into v_number
      from generate_series(1, (
        select coalesce(max(number), 0) + 1
          from public.pallets
         where destination = new.destination
           and status in ('open', 'closed')
           and shipment_id is null
      )) as t(n)
     where not exists (
       select 1 from public.pallets
        where destination = new.destination
          and status in ('open', 'closed')
          and shipment_id is null
          and number = t.n
     );

    new.number := v_number;
  end if;
  new.code := 'PAL-' || new.number;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- ------------------------------------------------------------
-- 3) Pašalinama dabar nebereikalinga skaitliuko lentelė
-- ------------------------------------------------------------
drop table if exists public.pallet_number_counters;

-- ------------------------------------------------------------
-- 4) reset_test_data() atnaujinamas — nebebando išvalyti pašalintos lentelės
-- ------------------------------------------------------------
create or replace function public.reset_test_data()
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  truncate table
    public.item_history,
    public.items,
    public.pallets,
    public.shipments
  cascade;

  truncate table public.pallet_ready_counters;

  return json_build_object('ok', true);
end;
$$;
