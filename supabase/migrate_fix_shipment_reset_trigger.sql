-- Paleisti Supabase Dashboard → SQL Editor
-- Pataiso pranešimą "paletžų numeravimas neatsistato po siuntos išsiuntimo"
-- (nauja paletė gauna tęstinį numerį, pvz. "5 paletė", nors turėtų būti
-- "1 paletė").
--
-- Ši funkcija/trigeris JAU turėjo egzistuoti (žr. migrate_dynamic_destination.sql
-- / schema.sql 18 sekciją) — šis skriptas tiesiog PRIVERSTINAI iš naujo
-- įdiegia TEISINGĄ (dabartinę, counter-lentele paremtą) versiją, nepriklausomai
-- nuo to, kokia versija šiuo metu realiai veikia jūsų DB (pvz. jei anksčiau
-- buvo paleista tik dalis migracijų ir liko sena, sequence'ais paremta
-- versija, kuri "destination in ('main','other')" atveju veikdavo teisingai,
-- bet su dinaminėmis paskirtimis (grizzly_prietaisai ir pan.) niekada
-- neatitinka nė vienos šakos ir tyliai nieko neatstato).
--
-- Papildomai: jei tos konkrečios destination counter eilutės dar nebūtų
-- (kraštutinis atvejis), paprastas UPDATE nieko nepaveiktų — todėl pridėtas
-- apsauginis upsert su reikšme 0.
--
-- Saugu paleisti pakartotinai (idempotentiška).

create or replace function public.reset_pallet_numbering_on_shipment_sent()
returns trigger as $$
begin
  if (tg_op = 'INSERT' and new.status = 'sent')
     or (tg_op = 'UPDATE' and new.status = 'sent' and old.status is distinct from 'sent') then
    update public.pallet_number_counters
       set current_number = 0
     where destination = new.destination;

    insert into public.pallet_number_counters (destination, current_number)
    values (new.destination, 0)
    on conflict (destination) do nothing;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists shipments_reset_pallet_numbering on public.shipments;
create trigger shipments_reset_pallet_numbering
  after insert or update on public.shipments
  for each row execute function public.reset_pallet_numbering_on_shipment_sent();
