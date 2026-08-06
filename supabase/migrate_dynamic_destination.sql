-- Paleisti Supabase Dashboard → SQL Editor
-- Katalogą papildo gamintojo/tipo laukais ir paverčia paletžų paskirtį (destination)
-- pilnai dinamiška: nebe fiksuota 'main'/'other', o "<gamintojas>_<tipas>" derinys
-- arba 'unclassified'. Numeravimas perkeliamas nuo dviejų Postgres sequence
-- objektų prie bendros counter lentelės, kad naujos paskirtys veiktų be schema pakeitimų.

-- 1) Catalog: gamintojas + tipas
alter table public.catalog
  add column if not exists manufacturer text,
  add column if not exists item_type text;

-- 2) Pallets/shipments: pašalinti fiksuotą 'main'/'other' apribojimą
alter table public.pallets
  drop constraint if exists pallets_destination_check,
  alter column destination set default 'unclassified';

alter table public.shipments
  drop constraint if exists shipments_destination_check,
  alter column destination set default 'unclassified';

-- 3) Bendra counter lentelė — kiekviena unikali destination reikšmė gauna
--    savo eilutę automatiškai (upsert), be schema pakeitimų ateityje.
create table if not exists public.pallet_number_counters (
  destination    text primary key,
  current_number integer not null default 0
);

comment on table public.pallet_number_counters is
  'Kiekvienos destination reikšmės dabartinis paletžų numeris. Naujos paskirtys atsiranda automatiškai per upsert, be schema pakeitimų.';

alter table public.pallet_number_counters enable row level security;
-- Jokių RLS policy nekuriame — lentelę valdo tik SECURITY DEFINER trigerio
-- funkcijos žemiau; tiesioginė prieiga iš front-end nenumatyta.

-- Saugiklis esamiems duomenims: jei jau yra paletžų su 'main'/'other' (iš
-- praėjusios versijos), išsaugo tęstinumą, kad naujas numeris nesusidubliuotų.
insert into public.pallet_number_counters (destination, current_number)
select destination, max(number)
  from public.pallets
 where number is not null
 group by destination
on conflict (destination) do nothing;

-- 4) Paletės numerio trigerio funkcija — vietoj nextval(sequence), atomiškas
--    upsert counter lentelėje.
create or replace function public.set_pallet_number()
returns trigger as $$
declare
  v_number integer;
begin
  if new.number is null then
    insert into public.pallet_number_counters (destination, current_number)
    values (new.destination, 1)
    on conflict (destination) do update
      set current_number = public.pallet_number_counters.current_number + 1
    returning current_number into v_number;

    new.number := v_number;
  end if;
  new.code := 'PAL-' || new.number;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- 5) Numeracijos atstatymo trigerio funkcija — atstato TIK tos destination eilutę.
create or replace function public.reset_pallet_numbering_on_shipment_sent()
returns trigger as $$
begin
  if (tg_op = 'INSERT' and new.status = 'sent')
     or (tg_op = 'UPDATE' and new.status = 'sent' and old.status is distinct from 'sent') then
    update public.pallet_number_counters
       set current_number = 0
     where destination = new.destination;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- 6) Admin reset — vietoj dviejų alter sequence, išvalo visą counter lentelę.
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

  truncate table public.pallet_number_counters;

  return json_build_object('ok', true);
end;
$$;

-- 7) Senos sequence — nuo šiol nebenaudojamos.
drop sequence if exists public.pallets_number_seq;
drop sequence if exists public.pallets_number_other_seq;
