-- Paleisti Supabase Dashboard → SQL Editor
-- Perkelia paletžų numeravimo skaitliuko atstatymą iš "siunta pažymėta
-- išsiųsta" (sent) momento į "paletė pažymėta paruošta išvežimui" (ready)
-- momentą.
--
-- Priežastis (sąmoningas pasirinkimas): kai visos vienos paskirties paletės
-- jau paruoštos išvežimui, sekanti nauja paletė turi pradėti numeraciją iš
-- naujo ("1 paletė"), NELAUKIANT, kol paruoštosios bus realiai išvežtos
-- (shipment su status='sent' sukurtas). Tai reiškia, kad tuo pačiu metu
-- sandėlyje gali būti dvi skirtingos paletės su tuo pačiu numeriu (viena
-- "ready", laukianti pasiėmimo, kita "open", dar pildoma) — tai sąmoningai
-- priimta rizika, ne klaida.
--
-- SVARBU: kadangi skaitliukas dabar atstatomas anksčiau (ready momentu),
-- senasis atstatymas siuntos "sent" momentu PANAIKINAMAS. Jei jis liktų —
-- vėliau, kai siunta pagaliau pažymima išsiųsta, jis klaidingai nunulintų
-- skaitliuką jau NAUJAM ciklui, kuris tarp "ready" ir realaus "sent" spėjo
-- prasidėti — t. y. ištrintų jau sunumeruotų naujų paletžų progresą ir
-- sukurtų numerių dublikatus.

-- 1) Panaikinamas senasis atstatymas siuntos "sent" momentu
drop trigger if exists shipments_reset_pallet_numbering on public.shipments;
drop function if exists public.reset_pallet_numbering_on_shipment_sent();

-- 2) Naujas atstatymas — paletei pereinant į "ready" būseną
create or replace function public.reset_pallet_numbering_on_ready()
returns trigger as $$
begin
  if new.status = 'ready' and old.status is distinct from 'ready' then
    update public.pallet_number_counters
       set current_number = 0
     where destination = new.destination;

    -- Apsauginis upsert, jei tos destination counter eilutės dar nebūtų.
    insert into public.pallet_number_counters (destination, current_number)
    values (new.destination, 0)
    on conflict (destination) do nothing;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists pallets_reset_numbering_on_ready on public.pallets;
create trigger pallets_reset_numbering_on_ready
  after update on public.pallets
  for each row execute function public.reset_pallet_numbering_on_ready();
