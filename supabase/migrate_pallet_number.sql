-- Paleisti Supabase Dashboard → SQL Editor
-- Prideda automatinį paletžų numeravimą (number stulpelis + trigeris)

-- 1. Sequence paletžų numeravimui
create sequence if not exists public.pallets_number_seq start 1;

-- 2. Naujas stulpelis
alter table public.pallets
  add column if not exists number integer;

-- 3. Trigeris: naujai paletei auto-priskiria number ir generuoja code
create or replace function public.set_pallet_number()
returns trigger as $$
begin
  if new.number is null then
    new.number := nextval('public.pallets_number_seq');
  end if;
  new.code := 'PAL-' || new.number;
  return new;
end;
$$ language plpgsql;

drop trigger if exists pallets_set_number on public.pallets;
create trigger pallets_set_number
  before insert on public.pallets
  for each row execute function public.set_pallet_number();
