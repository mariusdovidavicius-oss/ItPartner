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
  code        text not null,                   -- pvz. "PAL-2026-001" — NEBE unikalus, nes numeracija cikliškai atsistato po kiekvienos siuntos
  status      text not null default 'open'
              -- 'ready' = paruošta išvežimui (tarpinis žingsnis tarp 'closed'
              -- ir realaus priskyrimo shipment'ui) — žr. migrate_add_ready_status.sql
              check (status in ('open', 'closed', 'ready', 'shipped', 'delivered')),
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
-- 9. Trigeris: uždarius paletę → tik pažymėti supakavimo laiką
-- Siuntai paletė nebepriskiriama automatiškai čia — tai atliekama
-- rankiniu būdu per "/paletes" puslapį (žr. 14 sekciją, shipments insert).
-- ------------------------------------------------------------
drop trigger if exists pallets_auto_assign_shipment on public.pallets;
drop function if exists public.auto_assign_shipment();

create or replace function public.set_pallet_packed_at()
returns trigger as $$
begin
  -- Veikia tik kai status keičiasi į 'closed'
  if new.status = 'closed' and old.status is distinct from 'closed' and new.packed_at is null then
    new.packed_at := now();
  end if;
  return new;
end;
$$ language plpgsql;

create trigger pallets_set_packed_at
  before update on public.pallets
  for each row execute function public.set_pallet_packed_at();

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
  alter sequence public.pallets_number_other_seq restart with 1;

  return json_build_object('ok', true);
end;
$$;

revoke all on function public.reset_test_data() from public;
grant execute on function public.reset_test_data() to anon, authenticated;

-- ------------------------------------------------------------
-- 13. Trigeris: siuntą pažymėjus išsiųsta → atstatyti paletžų numeraciją
-- Dabar siunta sukuriama IŠKART su status='sent' (žr. 14 sekciją), todėl
-- trigeris turi reaguoti ir į INSERT, ne tik UPDATE.
-- (Naujai DB — čia; esamai DB naudoti migrate_reset_pallet_numbering.sql)
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 14. Rankinis siuntų formavimas (front-end insert)
-- Pastaba: shipments.shipment_id paletėms nebepriskiriamas automatiškai
-- (žr. 9 sekcijos pakeitimą). "/paletes" puslapyje vartotojas pasirenka
-- laukiančias (closed, shipment_id is null) paletes ir front-end kodas:
--   1) insert į shipments (code, status='sent', sent_at=now()) — kodas
--      generuojamas front-end pusėje pagal datą (pvz. "SIUNTA-2026-08-06",
--      su skaitiniu priedu, jei tą dieną jau yra siuntų su tokiu kodu);
--   2) update pallets set shipment_id = <naujas id> pažymėtoms paletėms.
-- Jokios papildomos DB funkcijos šiam žingsniui nereikia — RLS politika
-- "Anon and authenticated full access - shipments" (7 sekcija) jau leidžia
-- šiuos insert/update veiksmus.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 15. Paletžų PASKIRTIS (destination) — rankiniu būdu pasirenkama
-- skenavimo puslapyje, visada tarp dviejų fiksuotų reikšmių: 'main'
-- (įprastas sandėlis) / 'other' (kitas sandėlis). Kiekviena paskirtis
-- turi savo NEPRIKLAUSOMĄ numeravimo sequence.
-- (Naujai DB — čia; esamai DB naudoti migrate_add_destination.sql)
-- ------------------------------------------------------------
alter table public.pallets
  add column if not exists destination text not null default 'main'
  check (destination in ('main', 'other'));

create sequence if not exists public.pallets_number_other_seq start 1;

-- Perrašo 11 sekcijos set_pallet_number() — dabar renkasi sequence
-- pagal paletės destination.
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

-- ------------------------------------------------------------
-- 16. Siuntos (shipments) taip pat gauna "destination" — kiekviena
-- siunta apima TIK vienos paskirties paletes (tai užtikrina front-end),
-- todėl reikšmė nustatoma kuriant shipments įrašą "/paletes" puslapyje.
-- Numeracijos atstatymo trigeris (13 sekcija) perrašomas, kad
-- atstatytų TIK tos pačios paskirties sequence.
-- (Naujai DB — čia; esamai DB naudoti migrate_add_destination.sql)
-- ------------------------------------------------------------
alter table public.shipments
  add column if not exists destination text not null default 'main'
  check (destination in ('main', 'other'));

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

-- ------------------------------------------------------------
-- 17. CATALOG — papildomi laukai: gamintojas ir įrankio tipas
-- (Naujai DB — čia; esamai DB naudoti migrate_dynamic_destination.sql)
-- ------------------------------------------------------------
alter table public.catalog
  add column if not exists manufacturer text,
  add column if not exists item_type text;

-- ------------------------------------------------------------
-- 18. Dinaminė paletžų PASKIRTIS pagal gamintoją + tipą
-- Paskirtis (destination) nebėra fiksuota 'main'/'other' — ji generuojama
-- front-end pusėje kaip "<gamintojas>_<tipas>" (žr. src/lib/destination.js),
-- arba 'unclassified', jei kataloge nerasta arba trūksta lauko. Kadangi
-- kombinacijų gali daugėti be schema pakeitimų, numeravimas perkeliamas nuo
-- Postgres sequence objektų (15/16 sekcijos) prie bendros counter lentelės,
-- kurioje kiekviena unikali destination reikšmė turi savo eilutę.
-- (Naujai DB — čia; esamai DB naudoti migrate_dynamic_destination.sql)
-- ------------------------------------------------------------
alter table public.pallets
  drop constraint if exists pallets_destination_check,
  alter column destination set default 'unclassified';

alter table public.shipments
  drop constraint if exists shipments_destination_check,
  alter column destination set default 'unclassified';

create table if not exists public.pallet_number_counters (
  destination    text primary key,
  current_number integer not null default 0
);

comment on table public.pallet_number_counters is
  'Kiekvienos destination reikšmės dabartinis paletžų numeris. Naujos paskirtys atsiranda automatiškai per upsert, be schema pakeitimų.';

alter table public.pallet_number_counters enable row level security;
-- Jokių RLS policy nekuriame — lentelę valdo tik SECURITY DEFINER trigerio
-- funkcijos žemiau (jos veikia savininko teisėmis ir apeina RLS); tiesioginė
-- prieiga iš front-end (anon/authenticated) nenumatyta ir nereikalinga.

-- Perrašo 15 sekcijos set_pallet_number() — vietoj nextval(sequence) naudoja
-- atomišką upsert counter lentelėje, veikiantį bet kuriai destination reikšmei.
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

-- Perrašo 16 sekcijos reset_pallet_numbering_on_shipment_sent() — atstato
-- TIK tos pačios destination eilutę counter lentelėje. Jei tos destination
-- counter eilutės dar nebūtų (kraštutinis atvejis) — UPDATE nieko nepaveiktų
-- ir tyliai nieko nepakeistų, todėl papildomai upsert'inama eilutė su 0.
create or replace function public.reset_pallet_numbering_on_shipment_sent()
returns trigger as $$
begin
  if (tg_op = 'INSERT' and new.status = 'sent')
     or (tg_op = 'UPDATE' and new.status = 'sent' and old.status is distinct from 'sent') then
    update public.pallet_number_counters
       set current_number = 0
     where destination = new.destination;

    insert into public.pallet_number_counters (destination, current_number)
    values (new.destination, 0)
    on conflict (destination) do nothing;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- Perrašo 12 sekcijos reset_test_data() — vietoj dviejų alter sequence,
-- išvalo visą counter lentelę.
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

-- Senos, nuo šiol nebenaudojamos sequence — numeravimas dabar per counter lentelę.
drop sequence if exists public.pallets_number_seq;
drop sequence if exists public.pallets_number_other_seq;

-- ------------------------------------------------------------
-- 19. Trigeris: ištrynus TUŠČIĄ paletę (skenavimo puslapio mygtukas
-- "Ištrinti paletę"), sutvarkyti jos paskirties numeravimo skaitliuką.
-- Vietoj sąlyginio "-1" (kuris "įstringa", jei skaitliukas bent kartą
-- išsiderina su realiais duomenimis) TIESIOGIAI PERSKAIČIUOJAMAS tikras
-- maksimalus numeris tarp likusių, dar neišsiųstų (shipment_id is null)
-- tos paskirties paletžų — savaime pasitaiso nepriklausomai nuo ankstesnės
-- būklės. BEFORE DELETE trigeris pasirinktas vietoj atskiros RPC funkcijos,
-- kad skaitliukas liktų teisingas nepriklausomai nuo to, iš kur paletė
-- trinama — atitinka jau esamą trigerių pagrįstą numeravimo architektūrą
-- (11/15/18 sekcijos).
-- (Naujai DB — čia; esamai DB naudoti migrate_pallet_delete_counter.sql)
-- ------------------------------------------------------------
create or replace function public.decrement_pallet_counter_on_delete()
returns trigger as $$
declare
  v_max_remaining integer;
begin
  select coalesce(max(number), 0)
    into v_max_remaining
    from public.pallets
   where destination = old.destination
     and id <> old.id
     and shipment_id is null;

  update public.pallet_number_counters
     set current_number = v_max_remaining
   where destination = old.destination;

  return old;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists pallets_decrement_counter_on_delete on public.pallets;
create trigger pallets_decrement_counter_on_delete
  before delete on public.pallets
  for each row execute function public.decrement_pallet_counter_on_delete();

-- ------------------------------------------------------------
-- 20. Paletžų numeravimo atstatymas PERKELIAMAS iš "siunta pažymėta
-- išsiųsta" (sent) momento į "paletė pažymėta paruošta išvežimui" (ready)
-- momentą — sąmoningas pasirinkimas: kai visos vienos paskirties paletės
-- jau "ready", sekanti nauja paletė turi pradėti numeraciją iš naujo,
-- NELAUKIANT realaus išvežimo. Tai reiškia, kad tuo pačiu metu gali būti
-- dvi paletės su tuo pačiu numeriu (viena "ready", laukianti pasiėmimo,
-- kita "open", dar pildoma) — tai priimta rizika, ne klaida.
--
-- 13/16/18 sekcijų "shipments_reset_pallet_numbering" trigeris PANAIKINAMAS:
-- jei jis liktų, vėliau pažymint siuntą "sent" jis klaidingai nunulintų
-- skaitliuką jau NAUJAM ciklui, kuris tarp "ready" ir realaus "sent" spėjo
-- prasidėti — t. y. ištrintų jau sunumeruotų naujų paletžų progresą.
-- (Naujai DB — čia; esamai DB naudoti migrate_reset_numbering_on_ready.sql)
-- ------------------------------------------------------------
drop trigger if exists shipments_reset_pallet_numbering on public.shipments;
drop function if exists public.reset_pallet_numbering_on_shipment_sent();

create or replace function public.reset_pallet_numbering_on_ready()
returns trigger as $$
begin
  if new.status = 'ready' and old.status is distinct from 'ready' then
    update public.pallet_number_counters
       set current_number = 0
     where destination = new.destination;

    insert into public.pallet_number_counters (destination, current_number)
    values (new.destination, 0)
    on conflict (destination) do nothing;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists pallets_reset_numbering_on_ready on public.pallets;
create trigger pallets_reset_numbering_on_ready
  after update on public.pallets
  for each row execute function public.reset_pallet_numbering_on_ready();
