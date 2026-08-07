-- ============================================================
-- Dviejų eilių numeravimas:
--   closed  → gap-fill (1, 2, 3; jei #2 iškeltas → kita gauna #2)
--   ready   → paprastas skaitliukas (1, 2, 3, 4, 5, 6...)
-- Siuntą išsiuntus → ready skaitliukas atsistata į 0.
-- ============================================================

-- 1. Pašalinti likusį vieno-skaitliuko (closed) mechanizmą
drop trigger if exists pallets_reset_numbering_on_ready on public.pallets;
drop function if exists public.reset_pallet_numbering_on_ready();
drop table if exists public.pallet_number_counters;

-- 2. assign_pallet_number_on_close → gap-fill tarp esamų closed paletžų
create or replace function public.assign_pallet_number_on_close()
returns trigger as $$
declare
  v_number integer;
begin
  if new.status = 'closed' and old.status is distinct from 'closed' then
    select coalesce(min(t.n), 1)
      into v_number
      from generate_series(1, (
        select coalesce(max(number), 0) + 1
          from public.pallets
         where destination = new.destination
           and status = 'closed'
           and shipment_id is null
           and id <> new.id
      )) as t(n)
     where not exists (
       select 1 from public.pallets
        where destination = new.destination
          and status = 'closed'
          and shipment_id is null
          and id <> new.id
          and number = t.n
     );

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

-- 3. Sukurti ready eilės skaitliuką
create table if not exists public.pallet_ready_counters (
  destination      text primary key,
  current_position integer not null default 0
);

comment on table public.pallet_ready_counters is
  'Ready eilės pozicijos skaitliukas per destination. Atsistato kai siunta pažymima sent.';

alter table public.pallet_ready_counters enable row level security;

-- Užsėjame iš esamų ready paletžų
insert into public.pallet_ready_counters (destination, current_position)
select destination, coalesce(max(number), 0)
  from public.pallets
 where status = 'ready'
   and shipment_id is null
   and number is not null
 group by destination
on conflict (destination) do update set current_position = excluded.current_position;

-- 4. Trigeris: paletei tapus ready → gauna sekantį ready eilės numerį
create or replace function public.assign_pallet_ready_position()
returns trigger as $$
declare
  v_position integer;
begin
  if new.status = 'ready' and old.status is distinct from 'ready' then
    insert into public.pallet_ready_counters (destination, current_position)
    values (new.destination, 1)
    on conflict (destination) do update
      set current_position = public.pallet_ready_counters.current_position + 1
    returning current_position into v_position;

    new.number := v_position;
    new.code   := 'PAL-' || v_position;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists pallets_assign_ready_position on public.pallets;
create trigger pallets_assign_ready_position
  before update on public.pallets
  for each row execute function public.assign_pallet_ready_position();

-- 5. Trigeris: siuntą išsiuntus → ready skaitliukas atsistato
create or replace function public.reset_pallet_ready_position_on_sent()
returns trigger as $$
begin
  if (tg_op = 'INSERT' and new.status = 'sent')
     or (tg_op = 'UPDATE' and new.status = 'sent' and old.status is distinct from 'sent') then
    insert into public.pallet_ready_counters (destination, current_position)
    values (new.destination, 0)
    on conflict (destination) do update set current_position = 0;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists shipments_reset_ready_position on public.shipments;
create trigger shipments_reset_ready_position
  after insert or update on public.shipments
  for each row execute function public.reset_pallet_ready_position_on_sent();

-- 6. Administracinė funkcija — atnaujinama
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
