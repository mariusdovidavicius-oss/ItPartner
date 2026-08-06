-- Paleisti Supabase Dashboard → SQL Editor
-- Prideda paletžų "paskirties" (destination) požymį: 'main' (įprastas
-- sandėlis) / 'other' (kitas sandėlis), rankiniu būdu pasirenkamą
-- skenavimo puslapyje. Kiekviena paskirtis gauna savo nepriklausomą
-- paletžų numeravimo sequence, o numeracijos atstatymas po siuntos
-- uždarymo veikia tik tos pačios paskirties sequence.

-- 1) Naujas stulpelis "pallets" lentelėje
alter table public.pallets
  add column if not exists destination text not null default 'main'
  check (destination in ('main', 'other'));

-- 2) Atskira sequence "other" paskirties paletėms
create sequence if not exists public.pallets_number_other_seq start 1;

-- 3) Paletės numerio priskyrimo trigerio funkcija — renkasi sequence
--    pagal destination
create or replace function public.set_pallet_number()
returns trigger as $$
begin
  if new.number is null then
    if new.destination = 'other' then
      new.number := nextval('public.pallets_number_other_seq');
    else
      new.number := nextval('public.pallets_number_seq');
    end if;
  end if;
  new.code := 'PAL-' || new.number;
  return new;
end;
$$ language plpgsql;

-- 4) Naujas stulpelis "shipments" lentelėje (viena siunta = viena paskirtis)
alter table public.shipments
  add column if not exists destination text not null default 'main'
  check (destination in ('main', 'other'));

-- 5) Numeracijos atstatymo trigerio funkcija — atstato TIK tos pačios
--    paskirties sequence
create or replace function public.reset_pallet_numbering_on_shipment_sent()
returns trigger as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'sent' then
      if new.destination = 'other' then
        alter sequence public.pallets_number_other_seq restart with 1;
      else
        alter sequence public.pallets_number_seq restart with 1;
      end if;
    end if;
  elsif tg_op = 'UPDATE' then
    if new.status = 'sent' and old.status is distinct from 'sent' then
      if new.destination = 'other' then
        alter sequence public.pallets_number_other_seq restart with 1;
      else
        alter sequence public.pallets_number_seq restart with 1;
      end if;
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- 6) Admin reset (testavimo duomenų išvalymas) — dabar atstato ir "other" sequence
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

  alter sequence public.pallets_number_seq restart with 1;
  alter sequence public.pallets_number_other_seq restart with 1;

  return json_build_object('ok', true);
end;
$$;
