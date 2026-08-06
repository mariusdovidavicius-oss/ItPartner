-- Paleisti Supabase Dashboard → SQL Editor
-- Kai siunta pažymima kaip 'sent' (mygtukas "Pažymėti kaip išvežta"),
-- paletžų numeravimo sequence atstatomas atgal į 1 — sekanti nauja
-- paletė po siuntos uždarymo gaus numerį "1 paletė".

create or replace function public.reset_pallet_numbering_on_shipment_sent()
returns trigger as $$
begin
  if new.status = 'sent' and old.status is distinct from 'sent' then
    alter sequence public.pallets_number_seq restart with 1;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists shipments_reset_pallet_numbering on public.shipments;
create trigger shipments_reset_pallet_numbering
  after update on public.shipments
  for each row execute function public.reset_pallet_numbering_on_shipment_sent();
