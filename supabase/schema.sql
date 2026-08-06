-- ============================================================
-- Sandėlio valdymo sistema — Supabase (PostgreSQL) schema
-- Paleiskite šį failą per Supabase Dashboard → SQL Editor
-- ============================================================

-- Plėtiniai (UUID generavimui)
create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- 1. PALLETS — paletės / siuntos
-- ------------------------------------------------------------
create table if not exists public.pallets (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,           -- pvz. "PAL-2026-001"
  status      text not null default 'open'
              check (status in ('open', 'closed', 'shipped', 'delivered')),
  notes       text,
  created_at  timestamptz not null default now(),
  shipped_at  timestamptz
);

comment on table public.pallets is 'Paletės / siuntos, į kurias grupuojamos prekės.';

-- ------------------------------------------------------------
-- 2. ITEMS — pavienės prekės / įrankiai, registruojami pagal IAN kodą
-- ------------------------------------------------------------
create table if not exists public.items (
  id          uuid primary key default gen_random_uuid(),
  ian         text not null,                  -- modelio/prekės kodas; pasikartojimai normalūs (skirtingi to paties modelio vienetai)
  name        text,
  category    text,
  status      text not null default 'registered'
              check (status in ('registered', 'checked', 'packed', 'shipped', 'rejected')),
  notes       text,
  pallet_id   uuid references public.pallets (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.items is 'Pavienės prekės, registruojamos skenuojant / įvedant IAN kodą.';

-- Indeksai dažniausiems paieškos/filtravimo atvejams
create index if not exists items_ian_idx on public.items (ian);
create index if not exists items_status_idx on public.items (status);
create index if not exists items_pallet_id_idx on public.items (pallet_id);
create index if not exists items_created_at_idx on public.items (created_at desc);

-- Automatinis updated_at atnaujinimas
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists items_set_updated_at on public.items;
create trigger items_set_updated_at
  before update on public.items
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- 3. (Nebūtina) ITEM_HISTORY — įvykių / būsenų pakeitimų žurnalas
-- ------------------------------------------------------------
create table if not exists public.item_history (
  id          bigint generated always as identity primary key,
  item_id     uuid references public.items (id) on delete cascade,
  old_status  text,
  new_status  text,
  changed_at  timestamptz not null default now()
);

create or replace function public.log_item_status_change()
returns trigger as $$
begin
  if old.status is distinct from new.status then
    insert into public.item_history (item_id, old_status, new_status)
    values (new.id, old.status, new.status);
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists items_log_status_change on public.items;
create trigger items_log_status_change
  after update on public.items
  for each row execute function public.log_item_status_change();

-- ------------------------------------------------------------
-- 4. ROW LEVEL SECURITY (RLS)
-- ------------------------------------------------------------
-- Vidinei valdymo sistemai su prisijungusiais darbuotojais dažniausiai
-- pakanka leisti visus veiksmus autentifikuotiems (authenticated) vartotojams.
-- Jeigu programa naudos tik "anon" raktą be prisijungimo (pvz. uždaras vidinis
-- tinklas), pakeiskite "authenticated" į "anon" žemiau — bet tuomet
-- įsitikinkite, kad aplikacija nėra pasiekiama iš viešo interneto be apsaugos.

alter table public.pallets enable row level security;
alter table public.items enable row level security;
alter table public.item_history enable row level security;

create policy "Authenticated full access - pallets"
  on public.pallets for all
  to authenticated
  using (true)
  with check (true);

create policy "Authenticated full access - items"
  on public.items for all
  to authenticated
  using (true)
  with check (true);

create policy "Authenticated read access - item_history"
  on public.item_history for select
  to authenticated
  using (true);

-- ------------------------------------------------------------
-- 5. REALTIME
-- ------------------------------------------------------------
-- Įjungia realaus laiko srautą "items" ir "pallets" lentelėms.
alter publication supabase_realtime add table public.items;
alter publication supabase_realtime add table public.pallets;

-- ------------------------------------------------------------
-- 6. CATALOG — etaloninis IAN → pavadinimas katalogas (importuojamas iš Excel)
-- ------------------------------------------------------------
create table if not exists public.catalog (
  id           uuid primary key default gen_random_uuid(),
  ian          text not null unique,           -- IAN kodas, ištrauktas iš originalaus teksto
  name         text,                            -- pavadinimas be skliaustelių dalies
  raw_text     text,                            -- originalus pilnas tekstas iš Excel, neparsintas
  imported_at  timestamptz not null default now()
);

comment on table public.catalog is 'Etaloninis įrankių katalogas (IAN → pavadinimas), importuojamas iš Excel/CSV.';

create index if not exists catalog_ian_idx on public.catalog (ian);

alter table public.catalog enable row level security;

create policy "Authenticated full access - catalog"
  on public.catalog for all
  to authenticated
  using (true)
  with check (true);

-- ------------------------------------------------------------
-- 7. SHIPMENTS — siuntos (transporto užsakymui)
-- ------------------------------------------------------------
create table if not exists public.shipments (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,               -- pvz. "SIUNTA-2026-08-05-01"
  status      text not null default 'open'
              check (status in ('open', 'sent')),
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

comment on table public.shipments is 'Siuntos, į kurias grupuojamos uždarytos paletės. Sukuriamos automatiškai.';

alter table public.shipments enable row level security;

create policy "Anon and authenticated full access - shipments"
  on public.shipments for all
  to anon, authenticated
  using (true)
  with check (true);

alter publication supabase_realtime add table public.shipments;

-- ------------------------------------------------------------
-- 8. Nauji stulpeliai "pallets" lentelėje
-- ------------------------------------------------------------
alter table public.pallets
  add column if not exists shipment_id uuid references public.shipments (id) on delete set null,
  add column if not exists packed_at   timestamptz;

create index if not exists pallets_shipment_id_idx on public.pallets (shipment_id);

-- ------------------------------------------------------------
-- 9. Trigeris: uždarius paletę → automatiškai priskirti siuntai
-- ------------------------------------------------------------
create or replace function public.auto_assign_shipment()
returns trigger as $$
declare
  v_shipment_id uuid;
  v_date_str    text;
  v_seq         int;
  v_code        text;
begin
  -- Veikia tik kai status keičiasi į 'closed'
  if new.status = 'closed' and old.status is distinct from 'closed' then

    -- Nustatyti supakavimo datą
    if new.packed_at is null then
      new.packed_at := now();
    end if;

    -- Priskirti siuntai, jei dar nepriskirta
    if new.shipment_id is null then
      select id into v_shipment_id
        from public.shipments
       where status = 'open'
       order by created_at desc
       limit 1;

      -- Jei atviros siuntos nėra — sukurti naują
      if v_shipment_id is null then
        v_date_str := to_char(now(), 'YYYY-MM-DD');
        select count(*) + 1 into v_seq
          from public.shipments
         where to_char(created_at, 'YYYY-MM-DD') = v_date_str;
        v_code := 'SIUNTA-' || v_date_str || '-' || lpad(v_seq::text, 2, '0');
        insert into public.shipments (code, status) values (v_code, 'open')
          returning id into v_shipment_id;
      end if;

      new.shipment_id := v_shipment_id;
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists pallets_auto_assign_shipment on public.pallets;
create trigger pallets_auto_assign_shipment
  before update on public.pallets
  for each row execute function public.auto_assign_shipment();

-- ------------------------------------------------------------
-- 10. Kiekio stulpelis items lentelėje
-- (Naujai DB — stulpelis jau čia; esamai DB naudoti migrate_add_quantity.sql)
-- ------------------------------------------------------------
alter table public.items
  add column if not exists quantity integer not null default 1;

-- ------------------------------------------------------------
-- 11. Automatinis paletžų numeravimas
-- (Naujai DB — čia; esamai DB naudoti migrate_pallet_number.sql)
-- ------------------------------------------------------------
create sequence if not exists public.pallets_number_seq start 1;

alter table public.pallets
  add column if not exists number integer;

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

-- ------------------------------------------------------------
-- 12. Administracinė funkcija — testavimo duomenų išvalymas
-- (Esamai DB naudoti migrate_reset_function.sql)
-- ------------------------------------------------------------
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

  return json_build_object('ok', true);
end;
$$;

revoke all on function public.reset_test_data() from public;
grant execute on function public.reset_test_data() to anon, authenticated;
