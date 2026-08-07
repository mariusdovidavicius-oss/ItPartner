-- ============================================================
-- Paletžų numeravimo supaprastinimas
-- Numeris priskiriamas TIK uždarant paletę (status → 'closed').
-- Pašalinamas: gap-fill INSERT trigeris, pallet_ready_counters
-- pernumeravimas. Lieka: paprastas skaitliukas per paskirtį.
-- ============================================================

-- 1. Pašalinami seni trigeriai ir funkcijos
drop trigger if exists pallets_set_number on public.pallets;
drop function if exists public.set_pallet_number();

drop trigger if exists pallets_assign_ready_position on public.pallets;
drop function if exists public.assign_pallet_ready_position();

drop trigger if exists shipments_reset_ready_position on public.shipments;
drop function if exists public.reset_pallet_ready_position_on_sent();

drop table if exists public.pallet_ready_counters;

-- 2. "code" stulpelis tampa nullable — atviros paletės numerio neturi
alter table public.pallets alter column code drop not null;

-- 3. Atviros paletės neturi numerio — išvalome esamus (jei yra)
update public.pallets set number = null, code = null where status = 'open';

-- 4. Paprastas skaitliukas per paskirtį
create table if not exists public.pallet_number_counters (
  destination    text primary key,
  current_number integer not null default 0
);

comment on table public.pallet_number_counters is
  'Kiekvienos destination dabartinis paletžų numeris. Didinamas uždarant paletę, atsistato kai siunta pažymima sent.';

alter table public.pallet_number_counters enable row level security;

-- Užsėjame skaitliuką iš esamų neišsiųstų paletžų, kad sekantis numeris
-- nesikirstų su jau egzistuojančiais.
insert into public.pallet_number_counters (destination, current_number)
select destination, coalesce(max(number), 0)
  from public.pallets
 where status in ('closed', 'ready')
   and shipment_id is null
   and number is not null
 group by destination
on conflict (destination) do update set current_number = excluded.current_number;

-- 5. Trigeris: numeris priskiriamas kai paletė uždaroma (status → 'closed')
create or replace function public.assign_pallet_number_on_close()
returns trigger as $$
declare
  v_number integer;
begin
  if new.status = 'closed' and (old.status is distinct from 'closed') and new.number is null then
    insert into public.pallet_number_counters (destination, current_number)
    values (new.destination, 1)
    on conflict (destination) do update
      set current_number = public.pallet_number_counters.current_number + 1
    returning current_number into v_number;

    new.number := v_number;
    new.code   := 'PAL-' || v_number;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists pallets_assign_number_on_close on public.pallets;
create trigger pallets_assign_number_on_close
  before update on public.pallets
  for each row execute function public.assign_pallet_number_on_close();

-- 6. Trigeris: grąžinus paletę atgal į 'open' — numeris atimamas
--    (fiziškai ji jau ne sandėlyje, naują ciklą gaus naują numerį)
create or replace function public.clear_pallet_number_on_reopen()
returns trigger as $$
begin
  if new.status = 'open' and old.status is distinct from 'open' then
    new.number := null;
    new.code   := null;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists pallets_clear_number_on_reopen on public.pallets;
create trigger pallets_clear_number_on_reopen
  before update on public.pallets
  for each row execute function public.clear_pallet_number_on_reopen();

-- 7. Trigeris: paletę pažymėjus 'ready' → skaitliukas atsistato
--    Taip kita paletė, uždaroma po šio žingsnio, gauna Nr. 1.
--    Kiekvienas ready perėjimas nulinamas — pasikartojantis nulinimas
--    nekenkia (0 → 0), todėl nereikia tikrinti ar tai "pirmoji" ready paletė.
drop trigger if exists shipments_reset_pallet_numbering on public.shipments;
drop function if exists public.reset_pallet_numbering_on_shipment_sent();

create or replace function public.reset_pallet_numbering_on_ready()
returns trigger as $$
begin
  if new.status = 'ready' and old.status is distinct from 'ready' then
    insert into public.pallet_number_counters (destination, current_number)
    values (new.destination, 0)
    on conflict (destination) do update set current_number = 0;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists pallets_reset_numbering_on_ready on public.pallets;
create trigger pallets_reset_numbering_on_ready
  after update on public.pallets
  for each row execute function public.reset_pallet_numbering_on_ready();

-- 8. Administracinė funkcija — atnaujinama (pallet_ready_counters nebėra)
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
