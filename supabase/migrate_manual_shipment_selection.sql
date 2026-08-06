-- Paleisti Supabase Dashboard → SQL Editor
-- Pereinama nuo automatinio "atviros siuntos" grupavimo prie rankinio
-- paletžų pasirinkimo /paletes puslapyje (checkbox'ai + "Pažymėti kaip išvežta").

-- 1) Paletę uždarant nebepriskiriama shipment_id automatiškai —
--    paliekamas tik packed_at nustatymas.
drop trigger if exists pallets_auto_assign_shipment on public.pallets;
drop function if exists public.auto_assign_shipment();

create or replace function public.set_pallet_packed_at()
returns trigger as $$
begin
  if new.status = 'closed' and old.status is distinct from 'closed' and new.packed_at is null then
    new.packed_at := now();
  end if;
  return new;
end;
$$ language plpgsql;

create trigger pallets_set_packed_at
  before update on public.pallets
  for each row execute function public.set_pallet_packed_at();

-- 2) Paletžų numeravimo atstatymo trigeris dabar turi reaguoti ir į
--    INSERT (nes siunta front-end'e sukuriama iškart su status='sent'),
--    ne tik į UPDATE.
create or replace function public.reset_pallet_numbering_on_shipment_sent()
returns trigger as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'sent' then
      alter sequence public.pallets_number_seq restart with 1;
    end if;
  elsif tg_op = 'UPDATE' then
    if new.status = 'sent' and old.status is distinct from 'sent' then
      alter sequence public.pallets_number_seq restart with 1;
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists shipments_reset_pallet_numbering on public.shipments;
create trigger shipments_reset_pallet_numbering
  after insert or update on public.shipments
  for each row execute function public.reset_pallet_numbering_on_shipment_sent();
