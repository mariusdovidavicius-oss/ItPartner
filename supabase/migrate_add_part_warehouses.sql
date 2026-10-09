-- Paleisti Supabase Dashboard → SQL Editor
-- PALEIDIMO TVARKA: po migrate_add_device_warehouses.sql IR
-- migrate_search_lt_fold.sql (naudoja public.warehouses ir public.lt_lower()).
--
-- Priedai (parts) gauna privalomą sandėlį — tą patį public.warehouses
-- sąrašą, kaip ir prietaisai (tas pats fizinis sandėlis gali turėti ir
-- prietaisų, ir priedų). Kiekviena parts eilutė jau yra "vienas kodas vienoje
-- lokacijoje su savo kiekiu", tad sandėlis tampa tiesiog dar vienu tos
-- eilutės lauku (kaip device_stock.warehouse_id).
--
-- ESAMI priedai (ir testinėje, ir produkcinėje DB) automatiškai priskiriami
-- sandėliui "Lidl servisas" (sukuriamas, jei dar nėra) — vėliau jį galima
-- pakeisti priedo redagavimo lange arba importuojant iš naujo.
-- ------------------------------------------------------------

insert into public.warehouses (name)
select 'Lidl servisas'
where not exists (
  select 1 from public.warehouses where public.lt_lower(trim(name)) = public.lt_lower('Lidl servisas')
);

alter table public.parts
  add column if not exists warehouse_id uuid references public.warehouses (id);

update public.parts
  set warehouse_id = (
    select id from public.warehouses
    where public.lt_lower(trim(name)) = public.lt_lower('Lidl servisas')
  )
  where warehouse_id is null;

alter table public.parts
  alter column warehouse_id set not null;

create index if not exists parts_warehouse_id_idx on public.parts (warehouse_id);

comment on table public.warehouses is 'Fizinių sandėlių sąrašas (vien pavadinimas) — bendras prietaisams (device_stock) ir priedams (parts). Kuria/trina TIK adminas.';

-- ------------------------------------------------------------
-- import_parts() — kiekviena eilutė DABAR privalo nurodyti JAU
-- EGZISTUOJANČIO sandėlio pavadinimą (r->>'warehouse', neatsižvelgiant į
-- raidžių dydį). Eilutės su nerastu/nenurodytu sandėliu praleidžiamos
-- (neįterpiamos) — grąžinamas tik įterptų eilučių skaičius, kaip ir anksčiau.
--
-- clear_existing — DABAR išvalo TIK tų sandėlių priedus, kurie yra šiame
-- importe, ne VISUS priedus. Kitaip importuojant vieno sandėlio sąrašą
-- dingtų kitų sandėlių priedai. Kadangi importas siunčiamas dalimis (po 500
-- eilučių), front-end'as clear_existing perduoda tik PIRMAI daliai — todėl
-- sandėlių aibė imama iš p_clear_warehouse_ids (visų importo sandėlių id,
-- ne vien pirmos dalies).
-- ------------------------------------------------------------
drop function if exists public.import_parts(jsonb, boolean);

create or replace function public.import_parts(
  rows jsonb,
  clear_existing boolean default false,
  p_clear_warehouse_ids uuid[] default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer;
begin
  if not public.has_permission(auth.uid(), 'import') then
    raise exception 'Neturite importo teisės.';
  end if;

  if clear_existing then
    if not public.has_permission(auth.uid(), 'delete') then
      raise exception 'Norint prieš importą išvalyti esamus duomenis, reikia trynimo teisės.';
    end if;
    if p_clear_warehouse_ids is null or cardinality(p_clear_warehouse_ids) = 0 then
      raise exception 'Nenurodyta, kurių sandėlių priedus išvalyti.';
    end if;
    delete from public.parts where warehouse_id = any (p_clear_warehouse_ids);
  end if;

  insert into public.parts (warehouse_id, location, main_model, part_code, name, quantity, online_store, compatible_models)
  select
    w.id,
    r->>'location',
    nullif(r->>'main_model', ''),
    r->>'part_code',
    nullif(r->>'name', ''),
    coalesce((r->>'quantity')::integer, 0),
    coalesce((r->>'online_store')::boolean, false),
    nullif(r->>'compatible_models', '')
  from jsonb_array_elements(rows) as r
  join public.warehouses w
    on public.lt_lower(trim(w.name)) = public.lt_lower(trim(r->>'warehouse'));

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

grant execute on function public.import_parts(jsonb, boolean, uuid[]) to authenticated;
