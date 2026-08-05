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
  ian         text not null unique,           -- skenuojamas / įvedamas identifikacinis kodas
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
