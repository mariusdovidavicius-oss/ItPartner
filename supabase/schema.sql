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
$$ language plpgsql security definer set search_path = public;

drop trigger if exists items_log_status_change on public.items;
create trigger items_log_status_change
  after update on public.items
  for each row execute function public.log_item_status_change();

-- ------------------------------------------------------------
-- 4. ROW LEVEL SECURITY (RLS)
-- ------------------------------------------------------------
-- Programa NENAUDOJA Supabase Auth (žr. src/lib/supabaseClient.js — visur
-- tik VITE_SUPABASE_ANON_KEY, jokio supabase.auth iškvietimo), todėl KIEKVIENA
-- užklausa vykdoma kaip "anon" rolė, niekada "authenticated". Todėl "anon"
-- turi būti įtrauktas į kiekvienos lentelės, kurią naudoja front-end,
-- politiką — priešingu atveju RLS tyliai blokuotų visus veiksmus.
--
-- SVARBU: kadangi "anon" reiškia BET KAS su anon raktu (t. y. bet kas, kas
-- pasiekia aplikaciją), aplikacija NETURI būti pasiekiama iš viešo interneto
-- be papildomos apsaugos (VPN, IP apribojimas ir pan.). Jei kada nors
-- reikės realaus vartotojų atskyrimo/apskaitos, reikės pridėti Supabase Auth
-- ir pakeisti "anon, authenticated" į vien "authenticated".

alter table public.pallets enable row level security;
alter table public.items enable row level security;
alter table public.item_history enable row level security;

create policy "Anon and authenticated full access - pallets"
  on public.pallets for all
  to anon, authenticated
  using (true)
  with check (true);

create policy "Anon and authenticated full access - items"
  on public.items for all
  to anon, authenticated
  using (true)
  with check (true);

create policy "Anon and authenticated read access - item_history"
  on public.item_history for select
  to anon, authenticated
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

create policy "Anon and authenticated full access - catalog"
  on public.catalog for all
  to anon, authenticated
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
declare
  v_existing_ready_count integer;
begin
  if new.status = 'ready' and old.status is distinct from 'ready' then
    -- Atstatoma TIK jei tai pirma "ready" paletė tai paskirčiai (anksčiau
    -- nebuvo nė vienos) — kad prisijungimas prie jau esančio "ready"
    -- komplekto (žr. 21 sekciją) neatstatytų skaitliuko jau NAUJAM,
    -- tuo metu galbūt besikaupiančiam ciklui.
    select count(*) into v_existing_ready_count
      from public.pallets
     where destination = new.destination
       and status = 'ready'
       and shipment_id is null
       and id <> new.id;

    if v_existing_ready_count = 0 then
      update public.pallet_number_counters
         set current_number = 0
       where destination = new.destination;

      insert into public.pallet_number_counters (destination, current_number)
      values (new.destination, 0)
      on conflict (destination) do nothing;
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists pallets_reset_numbering_on_ready on public.pallets;
create trigger pallets_reset_numbering_on_ready
  after update on public.pallets
  for each row execute function public.reset_pallet_numbering_on_ready();

-- ------------------------------------------------------------
-- 21. "Ready" EILĖS POZICIJA — atskiras skaitliukas nuo darbinio (20
-- sekcijos). Kai paletė tampa "ready", ji PERNUMERUOJAMA pagal esamų
-- neišsiųstų "ready" paletžų tai paskirčiai skaičių + 1 — taip paletė,
-- prisijungianti prie jau esančio, dar neišsiųsto "ready" komplekto (pvz.
-- kurjeris gali paimti daugiau), gauna teisingą tęstinį numerį (pvz. "7",
-- ne "1"), o ne susikerta su jau esančiais numeriais tame pačiame komplekte.
-- Ši pozicija atsistato į 0 TIK kai siunta REALIAI pažymima "sent"
-- (kurjeris pasiėmė) — ne anksčiau, nes kol siunta nepasiimta, prie jos
-- gali prisijungti daugiau paletžų.
-- (Naujai DB — čia; esamai DB naudoti migrate_ready_position_renumbering.sql)
-- ------------------------------------------------------------
create table if not exists public.pallet_ready_counters (
  destination      text primary key,
  current_position integer not null default 0
);

comment on table public.pallet_ready_counters is
  'Kiekvienos destination dabartinė "paruošta išvežimui" eilės pozicija. Atskira nuo pallet_number_counters (darbinio, dar nepasiruošusioms paletėms numeruoti).';

alter table public.pallet_ready_counters enable row level security;

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
    new.code := 'PAL-' || v_position;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists pallets_assign_ready_position on public.pallets;
create trigger pallets_assign_ready_position
  before update on public.pallets
  for each row execute function public.assign_pallet_ready_position();

create or replace function public.reset_pallet_ready_position_on_sent()
returns trigger as $$
begin
  if (tg_op = 'INSERT' and new.status = 'sent')
     or (tg_op = 'UPDATE' and new.status = 'sent' and old.status is distinct from 'sent') then
    update public.pallet_ready_counters
       set current_position = 0
     where destination = new.destination;

    insert into public.pallet_ready_counters (destination, current_position)
    values (new.destination, 0)
    on conflict (destination) do nothing;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists shipments_reset_ready_position on public.shipments;
create trigger shipments_reset_ready_position
  after insert or update on public.shipments
  for each row execute function public.reset_pallet_ready_position_on_sent();

-- Perrašo ankstesnę reset_test_data() versiją — papildomai išvalo ir naują
-- pallet_ready_counters lentelę, kad po testinių duomenų išvalymo neliktų
-- senų "ready" pozicijų.
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
  truncate table public.pallet_ready_counters;

  return json_build_object('ok', true);
end;
$$;

-- ------------------------------------------------------------
-- 22. "Laukia paruošimo" / "Formuojama" (open/closed) paletžų numeravimas
-- PERTVARKOMAS iš skaitliuko (pallet_number_counters) į SPRAGOS PAIEŠKĄ
-- "gyvai" kiekvieną kartą kuriant naują paletę.
--
-- Problema: skaitliukas TIK didėja ir atsistato ties "ready" pažymėjimu —
-- jei pažymima TIK DALIS "Laukia paruošimo" paletžų kaip "ready" (pvz. iš
-- 1,2,3 tik "2"), likusiame sąraše lieka spraga ("1, 3"), o skaitliukas jos
-- "nemato" ir naujai paletei vis tiek duoda tęstinį (4, 5...) numerį, o ne
-- užpildo spragą.
--
-- Sprendimas: numeris randamas GYVAI — mažiausias trūkstamas skaičius tarp
-- esamų "open"/"closed" (dar nepriskirtų shipment'ui) paletžų tai
-- paskirčiai; jei tokių nėra nė vienos — 1.
--
-- Kadangi numeris dabar visada apskaičiuojamas iš TIKROS, esamos būklės,
-- šie mechanizmai tampa NEBEREIKALINGI ir PAŠALINAMI:
--   - pallet_number_counters lentelė
--   - reset_pallet_numbering_on_ready() (20 sekcija) — nereikalingas, nes
--     "gyva" paieška pati automatiškai "mato", kai sąrašas ištuštėja
--   - decrement_pallet_counter_on_delete() (19 sekcija) — nereikalingas,
--     nes ištrintos paletės numeris tiesiog taps "matoma" spraga
--
-- NELIEČIAMA: pallet_ready_counters / assign_pallet_ready_position /
-- reset_pallet_ready_position_on_sent (21 sekcija) — atskira sistema
-- "ready" eilės pozicijai, su šia logika nesusijusi.
-- (Naujai DB — čia; esamai DB naudoti migrate_gap_fill_pallet_numbering.sql)
-- ------------------------------------------------------------
drop trigger if exists pallets_decrement_counter_on_delete on public.pallets;
drop function if exists public.decrement_pallet_counter_on_delete();

drop trigger if exists pallets_reset_numbering_on_ready on public.pallets;
drop function if exists public.reset_pallet_numbering_on_ready();

create or replace function public.set_pallet_number()
returns trigger as $$
declare
  v_number integer;
begin
  if new.number is null then
    select coalesce(min(t.n), 1)
      into v_number
      from generate_series(1, (
        select coalesce(max(number), 0) + 1
          from public.pallets
         where destination = new.destination
           and status in ('open', 'closed')
           and shipment_id is null
      )) as t(n)
     where not exists (
       select 1 from public.pallets
        where destination = new.destination
          and status in ('open', 'closed')
          and shipment_id is null
          and number = t.n
     );

    new.number := v_number;
  end if;
  new.code := 'PAL-' || new.number;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop table if exists public.pallet_number_counters;

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

-- ------------------------------------------------------------
-- 23. PARTS — priedų (atsarginių dalių) sandėlio modulis
-- Nepriklausomas nuo paletžų/siuntų — savo lentelė, importuojama iš
-- atskiro Excel failo ("Stock List.xlsx"). Nėra patikimo unikalaus rakto
-- per eilutę šaltinio duomenyse (tas pats part_code gali kartotis
-- skirtingose lokacijose — tai normalu), todėl importas visada veikia
-- kaip paprastas insert, ne upsert.
-- (Naujai DB — čia; esamai DB naudoti migrate_add_parts.sql)
-- ------------------------------------------------------------
create table if not exists public.parts (
  id                 uuid primary key default gen_random_uuid(),
  location           text not null,                    -- "Lokacija" (laisvas tekstas, pvz. "42 (-7-)")
  main_model         text,                             -- "Pagrindinis Modelis"
  part_code          text not null,                    -- "Detalės Kodas" — text, nes formatas nevienodas (skaičius arba "352083/ZU21")
  name               text,                             -- "Pavadinimas"
  quantity           integer not null default 0,
  min_quantity       integer,                          -- individualus mažo likučio slenkstis; NULL = naudojama numatytoji reikšmė (3, žr. stock_level žemiau)
  online_store       boolean not null default false,   -- "El. parduotuvė" TAIP/NE
  compatible_models  text,                              -- "Suderinami Modeliai", žalias tekstas
  notes              text,                              -- laisva pastaba
  price              numeric(10, 2),                    -- orientacinė priedo kaina (€); NULL = nenurodyta; žr. migrate_add_part_price.sql
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint parts_min_quantity_check check (min_quantity is null or min_quantity >= 0),
  constraint parts_price_check check (price is null or price >= 0),
  -- Generuojamas (stored) stulpelis — leidžia /priedai likučio filtrui
  -- filtruoti per PostgREST paprastu .eq("stock_level", …), nes PostgREST
  -- negali filtruoti lygindamas du tos pačios eilutės stulpelius (quantity
  -- vs min_quantity) tiesiogiai užklausoje.
  stock_level        text generated always as (
    case
      when quantity <= 0 then 'out'
      when quantity <= coalesce(min_quantity, 3) then 'low'
      else 'ok'
    end
  ) stored
);

comment on table public.parts is 'Priedų (atsarginių dalių) sandėlio apskaita, importuojama iš Excel.';

create index if not exists parts_part_code_idx on public.parts (part_code);
create index if not exists parts_name_idx on public.parts (name);
create index if not exists parts_location_idx on public.parts (location);
create index if not exists parts_stock_level_idx on public.parts (stock_level);

drop trigger if exists parts_set_updated_at on public.parts;
create trigger parts_set_updated_at
  before update on public.parts
  for each row execute function public.set_updated_at();

alter table public.parts enable row level security;

-- ------------------------------------------------------------
-- Priedų modulio prisijungimas ir teisės (žr. migrate_add_parts_permissions.sql
-- esamai DB). Vartotojai neturi el. pašto — jungiasi "ID" (username), kuris
-- front-end pusėje paverčiamas į vidinį "<id>@parts.local" formatą Supabase
-- Auth reikmėms. Naujus vartotojus kuria tik adminas per api/create-user.js
-- arba pirmam adminui — scripts/bootstrap-admin.mjs.
-- ------------------------------------------------------------

-- 1) profiles — po vieną eilutę kiekvienam auth.users vartotojui
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text not null,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.profiles is 'Vieša info apie kiekvieną prisijungusį vartotoją (priedų modulio teisėms).';

-- Naujam auth.users įrašui automatiškai sukuria profiles eilutę.
create or replace function public.handle_new_parts_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_parts on auth.users;
create trigger on_auth_user_created_parts
  after insert on auth.users
  for each row execute function public.handle_new_parts_user();

-- 2) user_permissions — vartotojas × teisė (view/edit/delete/import).
-- Šis sąrašas turi atitikti src/lib/permissions.js ir api/create-user.js —
-- DB negali jų importuoti, tad keičiant sąrašą, atnaujinti visas tris vietas.
create table if not exists public.user_permissions (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  permission text not null check (permission in ('view', 'edit', 'delete', 'import')),
  granted_at timestamptz not null default now(),
  primary key (user_id, permission)
);

comment on table public.user_permissions is 'Kiekvienam vartotojui suteiktos priedų modulio teisės.';

-- 3) Pagalbinės funkcijos RLS taisyklėms (SECURITY DEFINER, kad išvengtų
-- RLS rekursijos tikrinant profiles/user_permissions iš pačių jų taisyklių).
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = uid), false);
$$;

create or replace function public.has_permission(uid uuid, perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin(uid) or exists (
    select 1 from public.user_permissions where user_id = uid and permission = perm
  );
$$;

grant execute on function public.is_admin(uuid) to authenticated, anon;
grant execute on function public.has_permission(uuid, text) to authenticated, anon;

-- 4) RLS: profiles ir user_permissions
alter table public.profiles enable row level security;
alter table public.user_permissions enable row level security;

create policy "Vartotojas mato savo profilį, adminas visus"
  on public.profiles for select
  to authenticated
  using (id = auth.uid() or public.is_admin(auth.uid()));

create policy "Adminas tvarko profilius"
  on public.profiles for update
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create policy "Vartotojas mato savo teises, adminas visas"
  on public.user_permissions for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin(auth.uid()));

create policy "Adminas tvarko teises"
  on public.user_permissions for all
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- 5) RLS: parts — peržiūra vieša (be prisijungimo, /priedai puslapis
-- pasiekiamas visiems), redagavimas/trynimas reikalauja atitinkamos teisės.
create policy "Vieša priedų peržiūra"
  on public.parts for select
  to anon, authenticated
  using (true);

create policy "Kūrimas/redagavimas pagal 'edit' teisę"
  on public.parts for insert
  to authenticated
  with check (public.has_permission(auth.uid(), 'edit'));

create policy "Atnaujinimas pagal 'edit' teisę"
  on public.parts for update
  to authenticated
  using (public.has_permission(auth.uid(), 'edit'))
  with check (public.has_permission(auth.uid(), 'edit'));

create policy "Trynimas pagal 'delete' teisę"
  on public.parts for delete
  to authenticated
  using (public.has_permission(auth.uid(), 'delete'));

-- 6) import_parts RPC — masinis Excel importas atskirai nuo 'edit'/'delete',
-- kad vartotojas su TIK 'import' teise galėtų importuoti, bet negalėtų
-- rankiniu būdu redaguoti/trinti pavienių įrašų. clear_existing papildomai
-- reikalauja 'delete' teisės. SECURITY DEFINER apeina eilutės lygio RLS
-- (pati funkcija patikrina teisę viduje).
create or replace function public.import_parts(rows jsonb, clear_existing boolean default false)
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
    delete from public.parts;
  end if;

  insert into public.parts (location, main_model, part_code, name, quantity, online_store, compatible_models)
  select
    r->>'location',
    nullif(r->>'main_model', ''),
    r->>'part_code',
    nullif(r->>'name', ''),
    coalesce((r->>'quantity')::integer, 0),
    coalesce((r->>'online_store')::boolean, false),
    nullif(r->>'compatible_models', '')
  from jsonb_array_elements(rows) as r;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

grant execute on function public.import_parts(jsonb, boolean) to authenticated;

alter publication supabase_realtime add table public.parts;

-- 7) parts_writeoffs — priedo nurašymas. Sumažina parts.quantity nurodytu
-- kiekiu ir palieka audito įrašą (kas/kada/kiek/kodėl). Reikalauja
-- "delete" teisės — ta pati, kuri jau naudojama pavienio priedo trynimui.
-- Priežastis (reason_type) — "parduota" (su kaina), "remontui" (su RMA
-- numeriu) arba "kita" (su laisvu tekstu); UI pusėje rodoma kaip dropdown
-- su papildomu lauku, priklausomu nuo pasirinkimo.
create table if not exists public.parts_writeoffs (
  id          uuid primary key default gen_random_uuid(),
  part_id     uuid not null references public.parts (id) on delete cascade,
  user_id     uuid references public.profiles (id) on delete set null,
  quantity    integer not null check (quantity > 0),
  reason_type text not null check (reason_type in ('parduota', 'remontui', 'kita')),
  price       numeric(10, 2),
  rma         text,
  reason      text,
  created_at  timestamptz not null default now(),
  -- Atšaukimas (žr. undo_writeoff() žemiau) — įrašas NETRINAMAS, tik
  -- pažymimas, kad liktų audito pėdsakas.
  undone_at   timestamptz,
  undone_by   uuid references public.profiles (id) on delete set null
);

comment on table public.parts_writeoffs is 'Priedų nurašymų (parduota/remontui/kita) audito istorija.';

create index if not exists parts_writeoffs_part_id_idx on public.parts_writeoffs (part_id);

alter table public.parts_writeoffs enable row level security;

create policy "Nurašymų istorija matoma pagal 'delete' teisę"
  on public.parts_writeoffs for select
  to authenticated
  using (public.has_permission(auth.uid(), 'delete'));

create or replace function public.writeoff_part(
  p_part_id uuid,
  p_quantity integer,
  p_reason_type text,
  p_price numeric default null,
  p_rma text default null,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_qty integer;
begin
  if not public.has_permission(auth.uid(), 'delete') then
    raise exception 'Neturite nurašymo teisės.';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Nurašomas kiekis turi būti didesnis už nulį.';
  end if;

  if p_reason_type not in ('parduota', 'remontui', 'kita') then
    raise exception 'Neteisinga nurašymo priežastis.';
  end if;

  if p_reason_type = 'parduota' and (p_price is null or p_price <= 0) then
    raise exception 'Įveskite kainą.';
  end if;

  if p_reason_type = 'remontui' and (p_rma is null or trim(p_rma) = '') then
    raise exception 'Įveskite RMA numerį.';
  end if;

  if p_reason_type = 'kita' and (p_reason is null or trim(p_reason) = '') then
    raise exception 'Įveskite priežastį.';
  end if;

  select quantity into v_current_qty from public.parts where id = p_part_id for update;
  if v_current_qty is null then
    raise exception 'Priedas nerastas.';
  end if;
  if p_quantity > v_current_qty then
    raise exception 'Nurašomas kiekis (%) negali viršyti turimo likučio (%).', p_quantity, v_current_qty;
  end if;

  update public.parts set quantity = quantity - p_quantity where id = p_part_id;

  insert into public.parts_writeoffs (part_id, user_id, quantity, reason_type, price, rma, reason)
  values (
    p_part_id,
    auth.uid(),
    p_quantity,
    p_reason_type,
    case when p_reason_type = 'parduota' then p_price else null end,
    case when p_reason_type = 'remontui' then nullif(trim(p_rma), '') else null end,
    case when p_reason_type = 'kita' then nullif(trim(p_reason), '') else null end
  );
end;
$$;

grant execute on function public.writeoff_part(uuid, integer, text, numeric, text, text) to authenticated;

-- Nurašymo atšaukimas — grąžina kiekį atgal į parts.quantity ir pažymi
-- įrašą kaip atšauktą (netrina, kad liktų audito pėdsakas). Galima atšaukti
-- tik kartą; reikalauja tos pačios "delete" teisės, kaip ir pats
-- nurašymas. Tiesioginės update politikos parts_writeoffs lentelei nėra —
-- atšaukti galima tik per šią SECURITY DEFINER funkciją.
create or replace function public.undo_writeoff(p_writeoff_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_part_id  uuid;
  v_quantity integer;
  v_undone   timestamptz;
begin
  if not public.has_permission(auth.uid(), 'delete') then
    raise exception 'Neturite teisės atšaukti nurašymo.';
  end if;

  select part_id, quantity, undone_at
    into v_part_id, v_quantity, v_undone
    from public.parts_writeoffs
    where id = p_writeoff_id
    for update;

  if v_part_id is null then
    raise exception 'Nurašymas nerastas.';
  end if;
  if v_undone is not null then
    raise exception 'Šis nurašymas jau atšauktas.';
  end if;

  update public.parts set quantity = quantity + v_quantity where id = v_part_id;

  update public.parts_writeoffs
    set undone_at = now(), undone_by = auth.uid()
    where id = p_writeoff_id;
end;
$$;

grant execute on function public.undo_writeoff(uuid) to authenticated;

alter publication supabase_realtime add table public.parts_writeoffs;

-- ------------------------------------------------------------
-- 24. Paletžų/siuntų modulio prisijungimas ir teisės.
-- Tapatybė (profiles/auth.users, prisijungimo ID/slaptažodis) lieka BENDRA
-- su priedų moduliu — Supabase Auth naršyklės lange palaiko tik vieną
-- aktyvią sesiją, tad atskiri "paletžų vartotojai" su savo prisijungimu
-- reikštų, kad tas pats žmogus turėtų dvi paskyras ir turėtų atsijungti/
-- prisijungti iš naujo norėdamas pereiti tarp priedų ir paletžų. Vietoj to
-- ATSKIRIAMOS TIK TEISĖS: nauja pallet_permissions lentelė, visiškai
-- nepriklausoma nuo user_permissions (priedų view/edit/delete/import).
--
-- Peržiūra (pallets/items/shipments SELECT) LIEKA VIEŠA visiems (anon),
-- kaip 1/7 sekcijose — keičiasi tik INSERT/UPDATE/DELETE, kurie dabar
-- reikalauja prisijungimo + atitinkamos teisės ('scan' arba 'ship').
-- (Naujai DB — čia; esamai DB naudoti migrate_add_pallet_permissions.sql)
-- ------------------------------------------------------------
create table if not exists public.pallet_permissions (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  permission text not null check (permission in ('scan', 'ship')),
  granted_at timestamptz not null default now(),
  primary key (user_id, permission)
);

comment on table public.pallet_permissions is 'Kiekvienam vartotojui suteiktos paletžų/siuntų modulio teisės — nepriklausomos nuo user_permissions (priedų).';

alter table public.pallet_permissions enable row level security;

create policy "Vartotojas mato savo paletžų teises, adminas visas"
  on public.pallet_permissions for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin(auth.uid()));

create policy "Adminas tvarko paletžų teises"
  on public.pallet_permissions for all
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create or replace function public.has_pallet_permission(uid uuid, perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin(uid) or exists (
    select 1 from public.pallet_permissions where user_id = uid and permission = perm
  );
$$;

grant execute on function public.has_pallet_permission(uuid, text) to authenticated, anon;

drop policy if exists "Anon and authenticated full access - pallets" on public.pallets;

create policy "Vieša palečių peržiūra"
  on public.pallets for select
  to anon, authenticated
  using (true);

create policy "Palečių kūrimas pagal 'scan' teisę"
  on public.pallets for insert
  to authenticated
  with check (public.has_pallet_permission(auth.uid(), 'scan'));

create policy "Palečių atnaujinimas pagal 'scan' arba 'ship' teisę"
  on public.pallets for update
  to authenticated
  using (public.has_pallet_permission(auth.uid(), 'scan') or public.has_pallet_permission(auth.uid(), 'ship'))
  with check (public.has_pallet_permission(auth.uid(), 'scan') or public.has_pallet_permission(auth.uid(), 'ship'));

create policy "Palečių trynimas pagal 'scan' teisę"
  on public.pallets for delete
  to authenticated
  using (public.has_pallet_permission(auth.uid(), 'scan'));

drop policy if exists "Anon and authenticated full access - items" on public.items;

create policy "Vieša prietaisų peržiūra"
  on public.items for select
  to anon, authenticated
  using (true);

create policy "Prietaisų kūrimas pagal 'scan' teisę"
  on public.items for insert
  to authenticated
  with check (public.has_pallet_permission(auth.uid(), 'scan'));

create policy "Prietaisų atnaujinimas pagal 'scan' teisę"
  on public.items for update
  to authenticated
  using (public.has_pallet_permission(auth.uid(), 'scan'))
  with check (public.has_pallet_permission(auth.uid(), 'scan'));

create policy "Prietaisų trynimas pagal 'scan' teisę"
  on public.items for delete
  to authenticated
  using (public.has_pallet_permission(auth.uid(), 'scan'));

drop policy if exists "Anon and authenticated full access - shipments" on public.shipments;

create policy "Vieša siuntų peržiūra"
  on public.shipments for select
  to anon, authenticated
  using (true);

create policy "Siuntų kūrimas pagal 'ship' teisę"
  on public.shipments for insert
  to authenticated
  with check (public.has_pallet_permission(auth.uid(), 'ship'));

create policy "Siuntų atnaujinimas pagal 'ship' teisę"
  on public.shipments for update
  to authenticated
  using (public.has_pallet_permission(auth.uid(), 'ship'))
  with check (public.has_pallet_permission(auth.uid(), 'ship'));

-- (Naujai DB — čia; esamai DB naudoti migrate_add_catalog_permission.sql)
drop policy if exists "Anon and authenticated full access - catalog" on public.catalog;

create policy "Vieša katalogo peržiūra"
  on public.catalog for select
  to anon, authenticated
  using (true);

create policy "Katalogo kūrimas pagal 'scan' teisę"
  on public.catalog for insert
  to authenticated
  with check (public.has_pallet_permission(auth.uid(), 'scan'));

create policy "Katalogo atnaujinimas pagal 'scan' teisę"
  on public.catalog for update
  to authenticated
  using (public.has_pallet_permission(auth.uid(), 'scan'))
  with check (public.has_pallet_permission(auth.uid(), 'scan'));

-- ------------------------------------------------------------
-- 25. DEVICES — prietaisų (įrangos) sandėlio modulis. Nepriklausomas nuo
-- items/pallets/shipments IR nuo parts (priedų) modulio, su savo teisėmis
-- (device_permissions). Duomenys normalizuoti į dvi lenteles, nes tas pats
-- IAN gali pasikartoti keliose Excel eilutėse (skiriasi tik kiekis/
-- lokacija/komentaras — skirtingos to paties modelio saugojimo vietos):
--   devices       — unikalus prietaiso MODELIS (IAN unikalus).
--   device_stock  — kiekis konkrečioje lokacijoje (device_id + location).
-- Komentaras (Excel "E") saugomas device_stock lygmenyje, ne devices, nes
-- paprastai apibūdina konkretaus likučio būklę konkrečioje lokacijoje.
--
-- Peržiūra (SELECT) VIEŠA — kaip items/pallets/shipments/catalog/parts,
-- sąrašą mato bet kas be prisijungimo. Redagavimas/trynimas/nurašymas/
-- importas ir toliau reikalauja prisijungimo + atitinkamos teisės.
-- (Naujai DB — čia; esamai DB naudoti migrate_add_devices.sql)
-- ------------------------------------------------------------
create table if not exists public.devices (
  id            uuid primary key default gen_random_uuid(),
  ian           text not null unique,           -- "IAN" — identifikuoja MODELĮ, ne fizinį vienetą
  name          text,                            -- "Prietaisas"
  manufacturer  text,                            -- "Gamintojas" (šiuo metu: Grizzly, Kompernass — laisvas tekstas, ne enum)
  notes         text,                            -- "Komentaras" — VIENAS visam prietaisui (ne per lokaciją, žr. migrate_devices_notes.sql)
  min_quantity  integer,                         -- individualus mažo likučio slenkstis (BENDRAM kiekiui per visas lokacijas); NULL = numatyta reikšmė (3, žr. device_totals.stock_level žemiau)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint devices_min_quantity_check check (min_quantity is null or min_quantity >= 0)
);

comment on table public.devices is 'Unikalūs prietaisų modeliai (IAN → pavadinimas/gamintojas/komentaras), be kiekio/lokacijos informacijos.';

create index if not exists devices_name_idx on public.devices (name);
create index if not exists devices_manufacturer_idx on public.devices (manufacturer);

drop trigger if exists devices_set_updated_at on public.devices;
create trigger devices_set_updated_at
  before update on public.devices
  for each row execute function public.set_updated_at();

-- Fizinių sandėlių (pastatų/vietų) sąrašas — lygmuo VIRŠ device_stock.location
-- (kuri lieka laisvas tekstas konkrečios lentynos/dėžės žymėjimui TO SANDĖLIO
-- viduje). Vien pavadinimas. Peržiūra vieša, kurti/trinti gali TIK adminas —
-- žr. migrate_add_device_warehouses.sql. Sandėlio pavadinimas front-end pusėje
-- rodomas TIK išskleidus prietaisą (NE pagrindinėje /prietaisai lentelėje).
create table if not exists public.warehouses (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

comment on table public.warehouses is 'Fizinių prietaisų sandėlių sąrašas (vien pavadinimas). Kuria/trina TIK adminas.';

alter table public.warehouses enable row level security;

create policy "Vieša sandėlių peržiūra"
  on public.warehouses for select
  to anon, authenticated
  using (true);

create policy "Adminas tvarko sandėlius"
  on public.warehouses for all
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create table if not exists public.device_stock (
  id            uuid primary key default gen_random_uuid(),
  device_id     uuid not null references public.devices (id) on delete cascade,
  warehouse_id  uuid not null references public.warehouses (id), -- KURIAME sandėlyje šis likutis yra
  location      text not null default '-',         -- "Lokacija" (laisvas tekstas, ne vien skaičiai) TO SANDĖLIO viduje
  quantity      integer not null default 0,
  notes         text,                               -- NEBENAUDOJAMAS front-end pusėje — komentaras nuo migrate_devices_notes.sql yra devices.notes (vienas visam prietaisui)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint device_stock_quantity_check check (quantity >= 0),
  -- (device_id, location) čia NEUŽTENKA — ta pati lokacija gali kartotis
  -- skirtinguose sandėliuose, tad warehouse_id įtraukiamas į unikalumą.
  constraint device_stock_device_warehouse_location_unique unique (device_id, warehouse_id, location)
);

comment on table public.device_stock is 'Prietaiso kiekis konkrečioje lokacijoje KONKREČIAME sandėlyje. Vienas (device_id, warehouse_id, location) turi tiksliai vieną eilutę.';

create index if not exists device_stock_warehouse_id_idx on public.device_stock (warehouse_id);

create index if not exists device_stock_device_id_idx on public.device_stock (device_id);
create index if not exists device_stock_location_idx on public.device_stock (location);

drop trigger if exists device_stock_set_updated_at on public.device_stock;
create trigger device_stock_set_updated_at
  before update on public.device_stock
  for each row execute function public.set_updated_at();

create table if not exists public.device_permissions (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  permission text not null check (permission in ('view', 'edit', 'delete', 'import')),
  granted_at timestamptz not null default now(),
  primary key (user_id, permission)
);

comment on table public.device_permissions is 'Kiekvienam vartotojui suteiktos prietaisų modulio teisės — nepriklausomos nuo user_permissions (priedų) ir pallet_permissions (paletžų).';

alter table public.device_permissions enable row level security;

create policy "Vartotojas mato savo prietaisų teises, adminas visas"
  on public.device_permissions for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin(auth.uid()));

create policy "Adminas tvarko prietaisų teises"
  on public.device_permissions for all
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create or replace function public.has_device_permission(uid uuid, perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin(uid) or exists (
    select 1 from public.device_permissions where user_id = uid and permission = perm
  );
$$;

grant execute on function public.has_device_permission(uuid, text) to authenticated, anon;

alter table public.devices enable row level security;
alter table public.device_stock enable row level security;

create policy "Vieša prietaisų peržiūra"
  on public.devices for select
  to anon, authenticated
  using (true);

create policy "Prietaisų kūrimas pagal 'edit' teisę"
  on public.devices for insert
  to authenticated
  with check (public.has_device_permission(auth.uid(), 'edit'));

create policy "Prietaisų atnaujinimas pagal 'edit' teisę"
  on public.devices for update
  to authenticated
  using (public.has_device_permission(auth.uid(), 'edit'))
  with check (public.has_device_permission(auth.uid(), 'edit'));

create policy "Prietaisų trynimas pagal 'delete' teisę"
  on public.devices for delete
  to authenticated
  using (public.has_device_permission(auth.uid(), 'delete'));

create policy "Vieša likučių peržiūra"
  on public.device_stock for select
  to anon, authenticated
  using (true);

create policy "Likučių kūrimas pagal 'edit' teisę"
  on public.device_stock for insert
  to authenticated
  with check (public.has_device_permission(auth.uid(), 'edit'));

create policy "Likučių atnaujinimas pagal 'edit' teisę"
  on public.device_stock for update
  to authenticated
  using (public.has_device_permission(auth.uid(), 'edit'))
  with check (public.has_device_permission(auth.uid(), 'edit'));

create policy "Likučių trynimas pagal 'delete' teisę"
  on public.device_stock for delete
  to authenticated
  using (public.has_device_permission(auth.uid(), 'delete'));

create or replace function public.import_devices(rows jsonb, p_clear_existing boolean default false)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  r              jsonb;
  v_ian          text;
  v_warehouse    text;
  v_warehouse_id uuid;
  v_location     text;
  v_device_id    uuid;
  device_count   integer := 0;
  stock_count    integer := 0;
  skipped_count  integer := 0;
begin
  if not public.has_device_permission(auth.uid(), 'import') then
    raise exception 'Neturite prietaisų importo teisės.';
  end if;

  if p_clear_existing then
    if not public.has_device_permission(auth.uid(), 'delete') then
      raise exception 'Norint prieš importą išvalyti esamus duomenis, reikia trynimo teisės.';
    end if;
    delete from public.devices;
  end if;

  for r in select * from jsonb_array_elements(rows)
  loop
    v_ian := nullif(trim(r->>'ian'), '');
    if v_ian is null then
      skipped_count := skipped_count + 1;
      continue;
    end if;

    -- Sandėlis TURI JAU EGZISTUOTI (sukurtas adminas) — importas jo savaime
    -- nekuria. Nenurodytas arba nerastas pavadinimas = visa eilutė praleidžiama
    -- (be sandėlio device_stock eilutės sukurti negalima, warehouse_id NOT NULL).
    v_warehouse := nullif(trim(r->>'warehouse'), '');
    v_warehouse_id := null;
    if v_warehouse is not null then
      select id into v_warehouse_id from public.warehouses
        where public.lt_lower(trim(name)) = public.lt_lower(v_warehouse);
    end if;
    if v_warehouse_id is null then
      skipped_count := skipped_count + 1;
      continue;
    end if;

    -- coalesce visuose trijuose laukuose — jei pakartotinio importo eilutėje
    -- (pvz. antra to paties IAN lokacijos eilutė) laukas tuščias, paliekama
    -- jau esama reikšmė, o ne perrašoma NULL.
    insert into public.devices (ian, name, manufacturer, notes)
    values (v_ian, nullif(r->>'name', ''), nullif(r->>'manufacturer', ''), nullif(r->>'notes', ''))
    on conflict (ian) do update
      set name = coalesce(excluded.name, public.devices.name),
          manufacturer = coalesce(excluded.manufacturer, public.devices.manufacturer),
          notes = coalesce(excluded.notes, public.devices.notes),
          updated_at = now()
    returning id into v_device_id;

    device_count := device_count + 1;

    v_location := coalesce(nullif(trim(r->>'location'), ''), '-');

    insert into public.device_stock (device_id, warehouse_id, location, quantity)
    values (
      v_device_id,
      v_warehouse_id,
      v_location,
      coalesce((r->>'quantity')::integer, 0)
    )
    on conflict (device_id, warehouse_id, location) do update
      set quantity = excluded.quantity,
          updated_at = now();

    stock_count := stock_count + 1;
  end loop;

  return json_build_object(
    'devices', device_count,
    'stock_rows', stock_count,
    'skipped', skipped_count
  );
end;
$$;

grant execute on function public.import_devices(jsonb, boolean) to authenticated;

alter publication supabase_realtime add table public.devices;
alter publication supabase_realtime add table public.device_stock;
alter publication supabase_realtime add table public.warehouses;

-- BŪTINA "security_invoker = true" — be jo VIEW vykdytų RLS VIEW SAVININKO
-- (Supabase atveju "postgres", turinčio BYPASSRLS) teisėmis ir visiškai
-- apeitų devices/device_stock RLS (žr. platesnį komentarą migrate_add_devices.sql).
create or replace view public.device_totals
with (security_invoker = true)
as
select
  d.id,
  d.ian,
  d.name,
  d.manufacturer,
  coalesce(sum(ds.quantity), 0)::integer as total_quantity,
  count(ds.id)::integer as location_count,
  d.min_quantity,
  case
    when coalesce(sum(ds.quantity), 0) <= 0 then 'out'
    when coalesce(sum(ds.quantity), 0) <= coalesce(d.min_quantity, 3) then 'low'
    else 'ok'
  end as stock_level
from public.devices d
left join public.device_stock ds on ds.device_id = d.id
group by d.id, d.ian, d.name, d.manufacturer, d.min_quantity;

comment on view public.device_totals is 'Kiekvieno prietaiso bendras kiekis, susumuotas per visas lokacijas, + mažo likučio būsena (stock_level: out/low/ok). security_invoker=true — vykdoma užklausėjo teisėmis, todėl paveldi devices/device_stock RLS.';

-- ------------------------------------------------------------
-- device_writeoffs — prietaisų nurašymo istorija, po lokaciją (žr.
-- migrate_add_device_writeoffs.sql). "location" saugoma kaip laisvas
-- tekstas (kopija nurašymo metu), ne FK į device_stock, kad audito įrašas
-- išliktų net ištrynus tos lokacijos likutį. "device_name"/"device_ian"
-- taip pat denormalizuoti (kopija nurašymo metu): device_id yra "on delete
-- set null" (ne cascade), tad ištrynus PATĮ PRIETAISĄ audito istorija
-- išlieka; be denormalizuotų laukų vardas/IAN dingtų kartu su devices
-- eilute, o be jų šiam sąrašui reikėtų JOIN su devices (kuriam RLS
-- reikalauja atskiros 'view' teisės, ne tik 'delete').
-- ------------------------------------------------------------
create table if not exists public.device_writeoffs (
  id            uuid primary key default gen_random_uuid(),
  device_id     uuid references public.devices (id) on delete set null,
  device_name   text,
  device_ian    text not null,
  location      text not null,
  warehouse_id  uuid references public.warehouses (id), -- KURIAM sandėliui priskirtas grąžinimas atšaukus (undo_device_writeoff)
  user_id       uuid references public.profiles (id) on delete set null,
  quantity    integer not null check (quantity > 0),
  reason_type text not null check (reason_type in ('parduota', 'remontui', 'kita', 'garantija')),
  price       numeric(10, 2),
  rma         text,
  reason      text,
  created_at  timestamptz not null default now(),
  undone_at   timestamptz,
  undone_by   uuid references public.profiles (id) on delete set null
);

comment on table public.device_writeoffs is 'Prietaisų nurašymų (parduota/remontui/kita) audito istorija, po lokaciją. device_name/device_ian denormalizuoti — išgyvena prietaiso ištrynimą.';

create index if not exists device_writeoffs_device_id_idx on public.device_writeoffs (device_id);

alter table public.device_writeoffs enable row level security;

create policy "Prietaisų nurašymų istorija matoma pagal 'delete' teisę"
  on public.device_writeoffs for select
  to authenticated
  using (public.has_device_permission(auth.uid(), 'delete'));

-- p_stock_id (device_stock.id) identifikuoja likutį VIENAREIKŠMIŠKAI —
-- device_id + location teksto NEBEUŽTENKA, nes ta pati lokacija gali
-- kartotis skirtinguose sandėliuose (žr. migrate_add_device_warehouses.sql).
create or replace function public.writeoff_device(
  p_stock_id uuid,
  p_quantity integer,
  p_reason_type text,
  p_price numeric default null,
  p_rma text default null,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_qty  integer;
  v_device_id    uuid;
  v_warehouse_id uuid;
  v_location     text;
  v_device_name  text;
  v_device_ian   text;
  v_writeoff_id  uuid;
begin
  if not public.has_device_permission(auth.uid(), 'delete') then
    raise exception 'Neturite nurašymo teisės.';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Nurašomas kiekis turi būti didesnis už nulį.';
  end if;

  if p_reason_type not in ('parduota', 'remontui', 'kita', 'garantija') then
    raise exception 'Neteisinga nurašymo priežastis.';
  end if;

  if p_reason_type = 'parduota' and (p_price is null or p_price <= 0) then
    raise exception 'Įveskite kainą.';
  end if;

  if p_reason_type = 'remontui' and (p_rma is null or trim(p_rma) = '') then
    raise exception 'Įveskite RMA numerį.';
  end if;

  if p_reason_type = 'kita' and (p_reason is null or trim(p_reason) = '') then
    raise exception 'Įveskite priežastį.';
  end if;

  select ds.quantity, ds.device_id, ds.warehouse_id, ds.location, d.name, d.ian
    into v_current_qty, v_device_id, v_warehouse_id, v_location, v_device_name, v_device_ian
    from public.device_stock ds
    join public.devices d on d.id = ds.device_id
    where ds.id = p_stock_id
    for update of ds;

  if v_device_id is null then
    raise exception 'Likutis nerastas.';
  end if;
  if p_quantity > v_current_qty then
    raise exception 'Nurašomas kiekis (%) negali viršyti turimo likučio (%).', p_quantity, v_current_qty;
  end if;

  update public.device_stock
    set quantity = quantity - p_quantity
    where id = p_stock_id;

  insert into public.device_writeoffs
    (device_id, device_name, device_ian, location, warehouse_id, user_id, quantity, reason_type, price, rma, reason)
  values (
    v_device_id,
    v_device_name,
    v_device_ian,
    v_location,
    v_warehouse_id,
    auth.uid(),
    p_quantity,
    p_reason_type,
    case when p_reason_type = 'parduota' then p_price else null end,
    case when p_reason_type = 'remontui' then nullif(trim(p_rma), '') else null end,
    case when p_reason_type in ('kita', 'garantija') then nullif(trim(p_reason), '') else null end
  )
  returning id into v_writeoff_id;

  return v_writeoff_id;
end;
$$;

grant execute on function public.writeoff_device(uuid, integer, text, numeric, text, text) to authenticated;

-- Jei pats PRIETAISAS ištrintas (device_id — "on delete set null" — jau
-- NULL), grąžinti kiekį nebėra kur, tad aiškiai pranešame vietoj to, kad
-- tyliai nieko nepadarytume arba klaidingai pažymėtume kaip atšauktą. Tas
-- pats — jei senas įrašas neturi sandėlio (warehouse_id null, prieš
-- migrate_add_device_warehouses.sql).
create or replace function public.undo_device_writeoff(p_writeoff_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device_id uuid;
  v_warehouse_id uuid;
  v_location  text;
  v_quantity  integer;
  v_undone    timestamptz;
begin
  if not public.has_device_permission(auth.uid(), 'delete') then
    raise exception 'Neturite teisės atšaukti nurašymo.';
  end if;

  select device_id, warehouse_id, location, quantity, undone_at
    into v_device_id, v_warehouse_id, v_location, v_quantity, v_undone
    from public.device_writeoffs
    where id = p_writeoff_id
    for update;

  if v_location is null then
    raise exception 'Nurašymas nerastas.';
  end if;
  if v_undone is not null then
    raise exception 'Šis nurašymas jau atšauktas.';
  end if;
  if v_device_id is null then
    raise exception 'Prietaisas ištrintas — nurašymo atšaukti nebegalima.';
  end if;
  if v_warehouse_id is null then
    raise exception 'Sandėlis nežinomas (senas įrašas be sandėlio) — nurašymo atšaukti nebegalima.';
  end if;

  insert into public.device_stock (device_id, warehouse_id, location, quantity)
  values (v_device_id, v_warehouse_id, v_location, v_quantity)
  on conflict (device_id, warehouse_id, location) do update
    set quantity = public.device_stock.quantity + excluded.quantity,
        updated_at = now();

  update public.device_writeoffs
    set undone_at = now(), undone_by = auth.uid()
    where id = p_writeoff_id;

  -- Jei šis nurašymas kilo iš atsinešimų sąrašo punkto (žr. device_pickups
  -- žemiau), tas punktas turi grįžti į "Paimta (dar nenurašyta)" būseną —
  -- kitaip liktų klaidingai rodomas kaip "Nurašyta".
  update public.device_pickups
    set writeoff_id = null
    where writeoff_id = p_writeoff_id;
end;
$$;

grant execute on function public.undo_device_writeoff(uuid) to authenticated;

alter publication supabase_realtime add table public.device_writeoffs;

-- ------------------------------------------------------------
-- device_pickups — atsinešimų sąrašo punktai (garantinio serviso
-- srautas: rasti/atsinešti iš sandėlio TO PATIES PAVADINIMO pakaitinį
-- prietaisą klientui, IAN dažniausiai skiriasi). TRYS atskiri žingsniai/
-- būsenos (SĄMONINGAI atskirti — fizinis daikto paėmimas iš lentynos ir
-- jo nurašymas iš apskaitos NĖRA tas pats momentas):
--   1) Laukia   — picked_at IS NULL.
--   2) Paimta   — picked_at IS NOT NULL, writeoff_id IS NULL (paprastas
--                 UPDATE, be jokio poveikio device_stock/device_writeoffs).
--   3) Nurašyta — writeoff_id IS NOT NULL (žr. finalize_device_pickup()
--                 žemiau — TIK dabar sumažinamas device_stock IR
--                 sukuriamas device_writeoffs audito įrašas).
-- ------------------------------------------------------------
create table if not exists public.device_pickups (
  id                    uuid primary key default gen_random_uuid(),
  device_id             uuid not null references public.devices (id) on delete cascade,
  quantity              integer not null check (quantity > 0),
  note                  text,
  user_id               uuid references public.profiles (id) on delete set null,
  created_at            timestamptz not null default now(),
  picked_at             timestamptz,
  picked_by             uuid references public.profiles (id) on delete set null,
  picked_stock_id       uuid references public.device_stock (id) on delete set null, -- KONKRETUS likutis, iš kurio bus nurašoma finalize_device_pickup() metu
  picked_location       text,                                                        -- teksto kopija rodymui (išgyvena picked_stock_id ištrynimą)
  picked_warehouse_name text,                                                        -- teksto kopija rodymui (išgyvena sandėlio/likučio ištrynimą)
  writeoff_id           uuid references public.device_writeoffs (id) on delete set null
);

comment on table public.device_pickups is 'Atsinešimų sąrašas (garantinis servisas) — "ką reikia atsinešti iš sandėlio" punktai. picked_at = fiziškai paimta; writeoff_id = papildomai nurašyta (žr. finalize_device_pickup()) — du atskiri žingsniai.';

create index if not exists device_pickups_device_id_idx on public.device_pickups (device_id);
create index if not exists device_pickups_pending_idx on public.device_pickups (created_at) where picked_at is null;

alter table public.device_pickups enable row level security;

create policy "Atsinešimų sąrašas matomas pagal 'edit' teisę"
  on public.device_pickups for select
  to authenticated
  using (public.has_device_permission(auth.uid(), 'edit'));

create policy "Punkto pridėjimas pagal 'edit' teisę"
  on public.device_pickups for insert
  to authenticated
  with check (public.has_device_permission(auth.uid(), 'edit'));

-- Trinti galima TIK dar nepaimtą punktą (picked_at is null) — kai punktas
-- jau paimtas (nesvarbu, nurašytas ar ne), jis nebelaikomas paprastu
-- "to-do" punktu.
create policy "Tik dar nepaimto punkto trynimas pagal 'edit' teisę"
  on public.device_pickups for delete
  to authenticated
  using (public.has_device_permission(auth.uid(), 'edit') and picked_at is null);

-- Pažymėti "paimta" — SECURITY DEFINER funkcija (NE tiesioginė UPDATE RLS
-- politika), kad "picked_by"/"picked_at" būtų nustatomi SERVERIO pusėje
-- (auth.uid()/now()), o ne kliento siunčiamais laukais. p_stock_id
-- (device_stock.id) — vienareikšmiškai identifikuoja, iš KURIO sandėlio/
-- lokacijos paimta (žr. migrate_add_device_warehouses.sql).
create or replace function public.mark_device_picked(p_pickup_id uuid, p_stock_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pickup_device_id uuid;
  v_picked_at        timestamptz;
  v_stock_device_id  uuid;
  v_location         text;
  v_warehouse_name   text;
begin
  if not public.has_device_permission(auth.uid(), 'edit') then
    raise exception 'Neturite teisės žymėti kaip paimta.';
  end if;

  select device_id, picked_at into v_pickup_device_id, v_picked_at
    from public.device_pickups where id = p_pickup_id for update;

  if not found then
    raise exception 'Sąrašo punktas nerastas.';
  end if;
  if v_picked_at is not null then
    raise exception 'Šis punktas jau pažymėtas kaip paimtas.';
  end if;

  select ds.device_id, ds.location, w.name
    into v_stock_device_id, v_location, v_warehouse_name
    from public.device_stock ds
    join public.warehouses w on w.id = ds.warehouse_id
    where ds.id = p_stock_id;

  if v_stock_device_id is null then
    raise exception 'Likutis nerastas.';
  end if;
  if v_stock_device_id <> v_pickup_device_id then
    raise exception 'Pasirinktas likutis priklauso kitam prietaisui.';
  end if;

  update public.device_pickups
    set picked_at = now(), picked_by = auth.uid(),
        picked_stock_id = p_stock_id, picked_location = v_location, picked_warehouse_name = v_warehouse_name
    where id = p_pickup_id;
end;
$$;

grant execute on function public.mark_device_picked(uuid, uuid) to authenticated;

-- Nurašymas (kiekio atėmimas) — TIK per šią SECURITY DEFINER funkciją,
-- reikalauja 'delete' teisės. Naudoja punkte jau užfiksuotą likutį
-- (picked_stock_id) ir kiekį/pastabą — antrą kartą jų rinktis nereikia.
create or replace function public.finalize_device_pickup(p_pickup_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quantity        integer;
  v_note            text;
  v_picked_at       timestamptz;
  v_stock_id        uuid;
  v_warehouse_name  text;
  v_writeoff_id     uuid;
begin
  if not public.has_device_permission(auth.uid(), 'delete') then
    raise exception 'Neturite nurašymo teisės.';
  end if;

  select quantity, note, picked_at, picked_stock_id, picked_warehouse_name, writeoff_id
    into v_quantity, v_note, v_picked_at, v_stock_id, v_warehouse_name, v_writeoff_id
    from public.device_pickups
    where id = p_pickup_id
    for update;

  if not found then
    raise exception 'Sąrašo punktas nerastas.';
  end if;
  if v_picked_at is null then
    raise exception 'Punktas dar nepažymėtas kaip paimtas.';
  end if;
  if v_writeoff_id is not null then
    raise exception 'Šis punktas jau nurašytas.';
  end if;
  if v_stock_id is null then
    -- picked_warehouse_name NULL = senas įrašas, pažymėtas "paimta" DAR PRIEŠ
    -- pridedant sandėlius (tuomet mark_device_picked() dar nesaugojo nei
    -- picked_stock_id, nei picked_warehouse_name) — nuo tikro VĖLIAU
    -- ištrinto likučio (picked_stock_id nustatomas į NULL per "on delete set
    -- null", bet picked_warehouse_name kopija išlieka) atskiriame būtent
    -- pagal šitą kopiją, kad pranešimas nebūtų klaidinantis.
    if v_warehouse_name is null then
      raise exception 'Senas įrašas be sandėlio informacijos (paimtas prieš pridedant sandėlius) — automatiškai nurašyti nebegalima, susisiekite su administratoriumi.';
    end if;
    raise exception 'Likutis, iš kurio buvo paimta, nebeegzistuoja — nurašyti nebegalima.';
  end if;

  v_writeoff_id := public.writeoff_device(v_stock_id, v_quantity, 'garantija', null, null, v_note);

  update public.device_pickups
    set writeoff_id = v_writeoff_id
    where id = p_pickup_id;
end;
$$;

grant execute on function public.finalize_device_pickup(uuid) to authenticated;

-- "Atgal" — grąžina klaidingai "paimtą" (bet DAR NENURAŠYTĄ) punktą atgal
-- į "Laukia" būseną. Jei jau nurašytas, pirma reikia atšaukti patį
-- nurašymą per undo_device_writeoff (jis automatiškai išvalo writeoff_id).
create or replace function public.unpick_device_pickup(p_pickup_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_picked_at   timestamptz;
  v_writeoff_id uuid;
begin
  if not public.has_device_permission(auth.uid(), 'edit') then
    raise exception 'Neturite teisės grąžinti punkto.';
  end if;

  select picked_at, writeoff_id into v_picked_at, v_writeoff_id
    from public.device_pickups
    where id = p_pickup_id
    for update;

  if not found then
    raise exception 'Sąrašo punktas nerastas.';
  end if;
  if v_picked_at is null then
    raise exception 'Punktas dar ir taip laukia — nėra ko grąžinti.';
  end if;
  if v_writeoff_id is not null then
    raise exception 'Punktas jau nurašytas — pirma atšaukite nurašymą.';
  end if;

  update public.device_pickups
    set picked_at = null, picked_by = null, picked_location = null,
        picked_stock_id = null, picked_warehouse_name = null
    where id = p_pickup_id;
end;
$$;

grant execute on function public.unpick_device_pickup(uuid) to authenticated;

alter publication supabase_realtime add table public.device_pickups;

-- ------------------------------------------------------------
-- 26. Paletžų numeravimo pertvarkymas — DVI ETAPais (abu buvo atskiri
-- migrate_*.sql, bet niekada nebuvo sulieti atgal į šį failą, todėl švari
-- DB, sukurta vien iš šio failo iki šios sekcijos, gautų PASENUSĮ (22
-- sekcijos) "gyvo spragos paieškos INSERT metu" mechanizmą vietoj to, kas
-- realiai naudojama šiandien). Sekcija tyčia palieka matomą tarpinį
-- "dviejų eilių" žingsnį (26a), kurį 26b iš dalies pakeičia/išvalo —
-- lygiai taip, kaip šios dvi migracijos buvo pritaikytos realioje DB, kad
-- galutinė būsena būtų garantuotai teisinga.
-- (Naujai DB — čia; esamai DB, kuri dar neturi šių dviejų, naudoti
-- migrate_two_queue_numbering.sql, tada migrate_simple_close_numbering.sql)
-- ------------------------------------------------------------

-- 26a. migrate_two_queue_numbering.sql — numeris priskiriamas UŽDARANT
-- paletę (ne kuriant), atskiras "ready" eilės pozicijos skaitliukas.
drop trigger if exists pallets_reset_numbering_on_ready on public.pallets;
drop function if exists public.reset_pallet_numbering_on_ready();
drop table if exists public.pallet_number_counters;

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

create table if not exists public.pallet_ready_counters (
  destination      text primary key,
  current_position integer not null default 0
);

comment on table public.pallet_ready_counters is
  'Ready eilės pozicijos skaitliukas per destination. Atsistato kai siunta pažymima sent.';

alter table public.pallet_ready_counters enable row level security;

insert into public.pallet_ready_counters (destination, current_position)
select destination, coalesce(max(number), 0)
  from public.pallets
 where status = 'ready'
   and shipment_id is null
   and number is not null
 group by destination
on conflict (destination) do update set current_position = excluded.current_position;

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

-- 26b. migrate_simple_close_numbering.sql — supaprastina 26a: numeris VIS
-- TIEK priskiriamas uždarant, bet nebe spragos paieška, o paprastas
-- skaitliukas; atskira "ready" eilės pozicijos sistema (26a) PANAIKINAMA;
-- "code" tampa nullable, nes atviros paletės numerio neturi.
drop trigger if exists pallets_set_number on public.pallets;
drop function if exists public.set_pallet_number();

drop trigger if exists pallets_assign_ready_position on public.pallets;
drop function if exists public.assign_pallet_ready_position();

drop trigger if exists shipments_reset_ready_position on public.shipments;
drop function if exists public.reset_pallet_ready_position_on_sent();

drop table if exists public.pallet_ready_counters;

alter table public.pallets alter column code drop not null;

update public.pallets set number = null, code = null where status = 'open';

create table if not exists public.pallet_number_counters (
  destination    text primary key,
  current_number integer not null default 0
);

comment on table public.pallet_number_counters is
  'Kiekvienos destination dabartinis paletžų numeris. Didinamas uždarant paletę, atsistato kai siunta pažymima sent.';

alter table public.pallet_number_counters enable row level security;

insert into public.pallet_number_counters (destination, current_number)
select destination, coalesce(max(number), 0)
  from public.pallets
 where status in ('closed', 'ready')
   and shipment_id is null
   and number is not null
 group by destination
on conflict (destination) do update set current_number = excluded.current_number;

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

-- ------------------------------------------------------------
-- 27. reset_test_data() — GALUTINĖ, teisinga versija.
-- Sujungia du atskirus, niekad anksčiau čia neatsispindėjusius pataisymus:
--   a) migrate_admin_reset_require_admin.sql — funkcija anksčiau (271 eil.
--      grant'as, niekad neatšauktas) buvo leidžiama BET KAM su viešu "anon"
--      raktu, nepriklausomai nuo to, ar /admin-reset puslapis užrakintas
--      React pusėje (lengvai apeinama kreipiantis tiesiai į Supabase REST
--      API). Dabar tikrinama is_admin() VIDUJE funkcijos ir anon prieiga
--      atšaukiama grant/revoke lygmenyje — dvigubas saugiklis.
--   b) svarbu: PATI migrate_admin_reset_require_admin.sql versija dar
--      turėjo "truncate table public.pallet_ready_counters" eilutę — ta
--      lentelė TADA JAU BUVO PAŠALINTA (žr. 26b aukščiau, ankstesnė
--      migracija chronologiškai). PL/pgSQL funkcijos kūrimo metu Postgres
--      NETIKRINA vidinių SQL sakinių prieš lentelių/stulpelių egzistavimą
--      (tikrinama tik iškvietimo metu) — tad CREATE OR REPLACE praeidavo
--      be klaidos, bet PATS admin-reset mygtukas gamyboje realiai mestų
--      klaidą "relation pallet_ready_counters does not exist" kiekvieną
--      kartą jį paspaudus. Čia ta eilutė pašalinta — teisinga versija
--      valo tik pallet_number_counters (26b sukurtą).
-- ------------------------------------------------------------
create or replace function public.reset_test_data()
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Tik administratorius gali išvalyti testavimo duomenis.';
  end if;

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

revoke all on function public.reset_test_data() from public, anon;
grant execute on function public.reset_test_data() to authenticated;

-- ------------------------------------------------------------
-- Statistikos funkcijos parts_stats() / device_stats()
-- (Naujai DB — čia; esamai DB naudoti migrate_add_stats_functions.sql)
-- ------------------------------------------------------------
-- Statistikos puslapio (/statistika) agregatai vienoje DB pusėje.
--
-- Anksčiau puslapis tempė visas parts/parts_writeoffs/device_* eilutes į
-- naršyklę ir sumavo ten. Supabase vienu atsakymu grąžina ne daugiau kaip
-- max_rows (pagal numatymą 1000) eilučių, todėl priedų/nurašymų skaičiui
-- perkopus 1000 sumos tyliai tapdavo per mažos. Dabar skaičiuoja DB, o
-- naršyklė gauna tik paruoštą JSON.
--
-- SECURITY INVOKER (numatytasis) — funkcijos vykdomos UŽKLAUSĖJO teisėmis,
-- todėl galioja tos pačios RLS taisyklės, kaip ir tiesioginėms užklausoms:
-- parts/devices/device_stock peržiūra vieša, o parts_writeoffs/device_writeoffs
-- rodomi tik su 'delete' teise (be jos nurašymų dalis grįžta tuščia).
--
-- Skaičiuojami TIK aktyvūs (neatšaukti, undone_at is null) nurašymai iš
-- intervalo [p_from, p_to): p_from įskaitytinai, p_to IŠSKIRTINĖ riba (kitos
-- dienos pradžia, todėl paskutinė pasirinkta diena įtraukiama visa); NULL =
-- riba neribojama, abu NULL = visas laikotarpis. price — SUMA UŽ VISĄ nurašomą
-- kiekį (ne už vienetą), todėl sumuojama be dauginimo.
--
-- Saugu paleisti pakartotinai (ir kaip atnaujinimą iš ankstesnės versijos, turėjusios
-- tik p_from): sena funkcija pašalinama, nes kitaip liktų dvi to paties vardo
-- funkcijos ir PostgreSQL nežinotų, kurią kviesti.
--
-- top_items grupuojamas pagal detalės kodą + pavadinimą (priedai) arba IAN +
-- pavadinimą (prietaisai), todėl tas pats priedas skirtingose lokacijose
-- (skirtingos parts eilutės) rodomas vienu įrašu.

drop function if exists public.parts_stats(timestamptz);
drop function if exists public.device_stats(timestamptz);

create or replace function public.parts_stats(p_from timestamptz default null, p_to timestamptz default null)
returns jsonb
language sql
stable
set search_path = public
as $$
  with active as (
    select w.quantity, w.reason_type, w.price, p.part_code, p.name, p.main_model
    from public.parts_writeoffs w
    join public.parts p on p.id = w.part_id
    where w.undone_at is null
      and (p_from is null or w.created_at >= p_from)
      and (p_to is null or w.created_at < p_to)
  )
  select jsonb_build_object(
    'overview', (
      select jsonb_build_object(
        'total_parts', count(*),
        'total_units', coalesce(sum(quantity), 0),
        'low_count',   count(*) filter (where stock_level = 'low'),
        'out_count',   count(*) filter (where stock_level = 'out')
      )
      from public.parts
    ),
    'writeoffs', jsonb_build_object(
      'total_qty', (select coalesce(sum(quantity), 0) from active),
      'revenue',   (select coalesce(sum(price) filter (where reason_type = 'parduota'), 0) from active),
      'by_reason', (
        select coalesce(jsonb_object_agg(reason_type, jsonb_build_object('count', c, 'qty', q)), '{}'::jsonb)
        from (
          select reason_type, count(*) as c, sum(quantity) as q
          from active
          group by reason_type
        ) r
      )
    ),
    'top_items', (
      select coalesce(jsonb_agg(
        jsonb_build_object('label', label, 'code', part_code, 'model', model, 'qty', qty)
        order by qty desc, label
      ), '[]'::jsonb)
      from (
        select
          coalesce(nullif(name, ''), part_code) as label,
          part_code,
          min(main_model) as model,
          sum(quantity) as qty
        from active
        group by part_code, coalesce(nullif(name, ''), part_code)
        order by sum(quantity) desc, coalesce(nullif(name, ''), part_code)
        limit 5
      ) t
    )
  );
$$;

create or replace function public.device_stats(p_from timestamptz default null, p_to timestamptz default null)
returns jsonb
language sql
stable
set search_path = public
as $$
  with active as (
    select w.quantity, w.reason_type, w.price, w.device_ian, w.device_name
    from public.device_writeoffs w
    where w.undone_at is null
      and (p_from is null or w.created_at >= p_from)
      and (p_to is null or w.created_at < p_to)
  )
  select jsonb_build_object(
    'overview', jsonb_build_object(
      'total_devices',  (select count(*) from public.devices),
      'total_units',    (select coalesce(sum(total_quantity), 0) from public.device_totals),
      'low_count',      (select count(*) from public.device_totals where stock_level = 'low'),
      'out_count',      (select count(*) from public.device_totals where stock_level = 'out'),
      'location_count', (select count(*) from public.device_stock)
    ),
    'writeoffs', jsonb_build_object(
      'total_qty', (select coalesce(sum(quantity), 0) from active),
      'revenue',   (select coalesce(sum(price) filter (where reason_type = 'parduota'), 0) from active),
      'by_reason', (
        select coalesce(jsonb_object_agg(reason_type, jsonb_build_object('count', c, 'qty', q)), '{}'::jsonb)
        from (
          select reason_type, count(*) as c, sum(quantity) as q
          from active
          group by reason_type
        ) r
      )
    ),
    'top_items', (
      select coalesce(jsonb_agg(
        jsonb_build_object('label', label, 'code', device_ian, 'model', null, 'qty', qty)
        order by qty desc, label
      ), '[]'::jsonb)
      from (
        select
          coalesce(nullif(device_name, ''), device_ian) as label,
          device_ian,
          sum(quantity) as qty
        from active
        group by device_ian, coalesce(nullif(device_name, ''), device_ian)
        order by sum(quantity) desc, coalesce(nullif(device_name, ''), device_ian)
        limit 5
      ) t
    )
  );
$$;

revoke all on function public.parts_stats(timestamptz, timestamptz) from public, anon;
revoke all on function public.device_stats(timestamptz, timestamptz) from public, anon;
grant execute on function public.parts_stats(timestamptz, timestamptz) to authenticated;
grant execute on function public.device_stats(timestamptz, timestamptz) to authenticated;

-- ============================================================
-- LT raidžių paieška + sandėlių pavadinimų unikalumas be raidžių dydžio
-- (žr. migrate_search_lt_fold.sql)
-- ============================================================
-- 1) Paieška be lietuviškų raidžių skirtumų: "sepetys" randa "šepetys" (ir
--    atvirkščiai), neatsižvelgiant į didžiąsias/mažąsias raides.
-- 2) Sandėlių pavadinimai unikalūs NEATSIŽVELGIANT į didžiąsias/mažąsias
--    raides ("Grizzly" ir "grizzly" — tas pats sandėlis), importas juos
--    atitinkamai ir sutapatina.
--
-- Kiekviena ieškoma lentelė gauna sugeneruotą (stored) stulpelį search_text
-- — visų ieškomų laukų "sulankstytą" kopiją. Front-end'as (src/lib/format.js
-- foldLt()) tą pačią transformaciją pritaiko paieškos tekstui ir filtruoja
-- per search_text ILIKE. Abi pusės TURI likti sinchronizuotos — keičiant
-- raidžių sąrašą čia, pakeisti ir foldLt().
-- ------------------------------------------------------------

-- lower() su "C" lokale nekeičia ne-ASCII didžiųjų raidžių, todėl LT
-- didžiosios verčiamos aiškiai per translate().
create or replace function public.lt_lower(t text)
returns text
language sql
immutable
parallel safe
as $
  select translate(lower(t), 'ĄČĘĖĮŠŲŪŽ', 'ąčęėįšųūž');
$;

create or replace function public.lt_fold(t text)
returns text
language sql
immutable
parallel safe
as $
  select translate(public.lt_lower(t), 'ąčęėįšųūž', 'aceeisuuz');
$;

-- concat_ws() nėra IMMUTABLE, todėl generated stulpeliuose naudojamas
-- coalesce(...) || ' ' || ...
alter table public.devices
  add column if not exists search_text text generated always as (
    public.lt_fold(coalesce(name, '') || ' ' || coalesce(ian, '') || ' ' || coalesce(manufacturer, ''))
  ) stored;

alter table public.parts
  add column if not exists search_text text generated always as (
    public.lt_fold(
      coalesce(part_code, '') || ' ' || coalesce(name, '') || ' ' ||
      coalesce(main_model, '') || ' ' || coalesce(compatible_models, '')
    )
  ) stored;

alter table public.device_writeoffs
  add column if not exists search_text text generated always as (
    public.lt_fold(coalesce(device_name, '') || ' ' || coalesce(device_ian, ''))
  ) stored;

alter table public.items
  add column if not exists search_text text generated always as (
    public.lt_fold(coalesce(ian, '') || ' ' || coalesce(name, ''))
  ) stored;

alter table public.catalog
  add column if not exists search_text text generated always as (
    public.lt_fold(coalesce(name, ''))
  ) stored;

-- ------------------------------------------------------------
-- Sandėliai — unikalumas pagal lt_lower(trim(name)). Jei jau yra dviejų
-- pavadinimų, kurie skiriasi tik raidžių dydžiu, indekso kūrimas nutrūks
-- su aiškia klaida — tada pirma rankiniu būdu sujungti/pervadinti.
-- ------------------------------------------------------------
create unique index if not exists warehouses_name_ci_unique
  on public.warehouses (public.lt_lower(trim(name)));

-- ============================================================
-- Priedų sandėliai (žr. migrate_add_part_warehouses.sql). Esami priedai
-- priskiriami "Lidl servisas"; import_parts() perrašoma su sandėliu.
-- ============================================================
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
as $
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
$;

grant execute on function public.import_parts(jsonb, boolean, uuid[]) to authenticated;

-- ============================================================
-- Prietaiso kiekio perkėlimas tarp vietų (žr. migrate_add_device_stock_transfer.sql)
-- ============================================================
create or replace function public.transfer_device_stock(
  p_from_stock_id uuid,
  p_to_warehouse_id uuid,
  p_to_location text,
  p_quantity integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $
declare
  v_device_id      uuid;
  v_from_wh        uuid;
  v_from_location  text;
  v_from_qty       integer;
  v_to_location    text := coalesce(nullif(trim(p_to_location), ''), '-');
  v_to_stock_id    uuid;
  v_to_wh_name     text;
  v_reserved       integer;
begin
  if not public.has_device_permission(auth.uid(), 'edit') then
    raise exception 'Neturite teisės perkelti prietaisų.';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Perkeliamas kiekis turi būti didesnis už nulį.';
  end if;

  select device_id, warehouse_id, location, quantity
    into v_device_id, v_from_wh, v_from_location, v_from_qty
    from public.device_stock
    where id = p_from_stock_id
    for update;

  if v_device_id is null then
    raise exception 'Likutis nerastas.';
  end if;
  if p_quantity > v_from_qty then
    raise exception 'Perkeliamas kiekis (%) negali viršyti turimo likučio (%).', p_quantity, v_from_qty;
  end if;

  select name into v_to_wh_name from public.warehouses where id = p_to_warehouse_id;
  if v_to_wh_name is null then
    raise exception 'Sandėlis nerastas.';
  end if;

  if p_to_warehouse_id = v_from_wh and v_to_location = v_from_location then
    raise exception 'Perkelti į tą pačią vietą negalima.';
  end if;

  select coalesce(sum(quantity), 0) into v_reserved
    from public.device_pickups
    where picked_stock_id = p_from_stock_id and writeoff_id is null;

  if p_quantity < v_from_qty and v_from_qty - p_quantity < v_reserved then
    raise exception 'Iš šios vietos jau pažymėta „Paimta“ % vnt. — joje turi likti bent tiek (galima perkelti daugiausia % vnt. arba visą kiekį).',
      v_reserved, greatest(v_from_qty - v_reserved, 0);
  end if;

  insert into public.device_stock (device_id, warehouse_id, location, quantity)
  values (v_device_id, p_to_warehouse_id, v_to_location, p_quantity)
  on conflict (device_id, warehouse_id, location) do update
    set quantity = public.device_stock.quantity + excluded.quantity,
        updated_at = now()
  returning id into v_to_stock_id;

  if p_quantity = v_from_qty then
    update public.device_pickups
      set picked_stock_id = v_to_stock_id,
          picked_location = v_to_location,
          picked_warehouse_name = v_to_wh_name
      where picked_stock_id = p_from_stock_id and writeoff_id is null;

    delete from public.device_stock where id = p_from_stock_id;
  else
    update public.device_stock
      set quantity = quantity - p_quantity
      where id = p_from_stock_id;
  end if;

  return v_to_stock_id;
end;
$;

revoke all on function public.transfer_device_stock(uuid, uuid, text, integer) from public, anon;
grant execute on function public.transfer_device_stock(uuid, uuid, text, integer) to authenticated;

-- ------------------------------------------------------------
-- (migrate_part_unique_and_transfer.sql)
--
-- 1) Tas pats priedas (detalės kodas) tame pačiame sandėlyje + lokacijoje
--    gali būti TIK viena parts eilutė. Palyginimas — be tarpų kraštuose ir
--    neatsižvelgiant į raidžių dydį (lt_lower), t.y. "42a" = "42A ".
--    Priedams be numerio ("N/A", tuščias, "-") unikalumas netaikomas.
--    Jau esantys dublikatai prieš kuriant indeksą sujungiami į seniausią
--    eilutę (žr. 0 žingsnį). Patikrinti, ar jų yra:
--      select warehouse_id, lt_lower(trim(location)), lt_lower(trim(part_code)), count(*)
--        from parts group by 1, 2, 3 having count(*) > 1;
-- 2) import_parts() — pasikartojančios failo eilutės sujungiamos (kiekiai
--    sudedami), o jau esantis priedas ATNAUJINAMAS (kiekis perrašomas failo
--    reikšme), ne dubliuojamas.
-- 3) transfer_part_stock() — priedo kiekio perkėlimas į kitą sandėlį/lokaciją.
-- ------------------------------------------------------------

-- 0) Esami dublikatai (tas pats kodas tame pačiame sandėlyje + lokacijoje)
-- sujungiami į seniausią eilutę: kiekiai sudedami, tušti laukai užpildomi
-- iš kitų eilučių, kitų eilučių pagrindiniai modeliai pridedami prie
-- suderinamų (jei jų ten dar nėra), nurašymai perkeliami, dublikatai ištrinami.
drop table if exists _dup_map;
create temp table _dup_map as
select id, canon
from (
  select
    id,
    first_value(id) over (
      partition by warehouse_id, public.lt_lower(trim(location)), public.lt_lower(trim(part_code))
      order by created_at, id
    ) as canon,
    count(*) over (
      partition by warehouse_id, public.lt_lower(trim(location)), public.lt_lower(trim(part_code))
    ) as cnt
  from public.parts
  where lower(trim(part_code)) not in ('', 'n/a', 'na', '-')
) t
where cnt > 1;

update public.parts c
  set quantity          = m.quantity,
      online_store      = m.online_store,
      name              = coalesce(nullif(trim(c.name), ''), m.name),
      price             = coalesce(c.price, m.price),
      min_quantity      = coalesce(c.min_quantity, m.min_quantity),
      notes             = m.notes,
      compatible_models = concat_ws(E'\n', nullif(trim(c.compatible_models), ''), m.extra_models)
  from (
    select
      d.canon,
      sum(p.quantity)::integer as quantity,
      bool_or(p.online_store) as online_store,
      (array_agg(p.name order by p.created_at, p.id) filter (where nullif(trim(p.name), '') is not null))[1] as name,
      (array_agg(p.price order by p.created_at, p.id) filter (where p.price is not null))[1] as price,
      (array_agg(p.min_quantity order by p.created_at, p.id) filter (where p.min_quantity is not null))[1] as min_quantity,
      string_agg(distinct nullif(trim(p.notes), ''), E'\n') as notes,
      string_agg(distinct trim(p.main_model), E'\n') filter (
        where d.id <> d.canon
          and nullif(trim(p.main_model), '') is not null
          and public.lt_lower(trim(p.main_model)) <> public.lt_lower(trim(coalesce(k.main_model, '')))
          and strpos(public.lt_lower(coalesce(k.compatible_models, '')), public.lt_lower(trim(p.main_model))) = 0
      ) as extra_models
    from public.parts p
    join _dup_map d on d.id = p.id
    join public.parts k on k.id = d.canon
    group by d.canon
  ) m
  where c.id = m.canon;

update public.parts_writeoffs w
  set part_id = d.canon
  from _dup_map d
  where d.id = w.part_id and d.id <> d.canon;

delete from public.parts p
  using _dup_map d
  where d.id = p.id and d.id <> d.canon;

drop table _dup_map;

-- "N/A" (ir tuščias/"-") = detalė neturi numerio — tokie priedai yra
-- SKIRTINGI daiktai (pvz. šlifavimo lapeliai K80/K100 toje pačioje dėžėje),
-- tad unikalumas jiems netaikomas (dalinis indeksas).
create unique index if not exists parts_warehouse_location_code_unique
  on public.parts (warehouse_id, public.lt_lower(trim(location)), public.lt_lower(trim(part_code)))
  where lower(trim(part_code)) not in ('', 'n/a', 'na', '-');

-- ------------------------------------------------------------
-- import_parts() — grąžina json {inserted, updated} (anksčiau integer).
-- Esamo priedo atnaujinimas: kiekis perrašomas; tekstiniai laukai
-- perrašomi tik jei faile netušti; online_store — tik jei eilutėje yra
-- raktas 'online_store' (front-end jį siunčia tik kai stulpelis susietas).
-- Front-end jau sujungia dublikatus per VISĄ failą (ne tik vieną dalį),
-- čia group by — apsauga, kad ON CONFLICT neliestų tos pačios eilutės du kartus.
-- ------------------------------------------------------------
drop function if exists public.import_parts(jsonb, boolean, uuid[]);

create or replace function public.import_parts(
  rows jsonb,
  clear_existing boolean default false,
  p_clear_warehouse_ids uuid[] default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer;
  v_updated  integer;
  v_has_online_store boolean := exists (
    select 1 from jsonb_array_elements(rows) as r where r ? 'online_store'
  );
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

  with src as (
    select
      w.id as warehouse_id,
      trim(r->>'location') as location,
      trim(r->>'part_code') as part_code,
      nullif(r->>'main_model', '') as main_model,
      nullif(r->>'name', '') as name,
      coalesce((r->>'quantity')::integer, 0) as quantity,
      coalesce((r->>'online_store')::boolean, false) as online_store,
      nullif(r->>'compatible_models', '') as compatible_models
    from jsonb_array_elements(rows) as r
    join public.warehouses w
      on public.lt_lower(trim(w.name)) = public.lt_lower(trim(r->>'warehouse'))
    where coalesce(trim(r->>'part_code'), '') <> '' and r->>'location' is not null
  ),
  grouped as (
    select
      warehouse_id,
      min(location) as location,
      min(part_code) as part_code,
      max(main_model) as main_model,
      max(name) as name,
      sum(quantity)::integer as quantity,
      bool_or(online_store) as online_store,
      max(compatible_models) as compatible_models
    from src
    -- Be numerio (N/A) eilutės nejungiamos — kiekviena lieka atskira (id).
    group by warehouse_id, public.lt_lower(location), public.lt_lower(part_code),
             case when lower(part_code) in ('', 'n/a', 'na', '-') then gen_random_uuid() end
  ),
  upserted as (
    insert into public.parts (warehouse_id, location, part_code, main_model, name, quantity, online_store, compatible_models)
    select warehouse_id, location, part_code, main_model, name, quantity, online_store, compatible_models
    from grouped
    on conflict (warehouse_id, public.lt_lower(trim(location)), public.lt_lower(trim(part_code)))
      where lower(trim(part_code)) not in ('', 'n/a', 'na', '-')
      do update
      set quantity          = excluded.quantity,
          main_model        = coalesce(excluded.main_model, public.parts.main_model),
          name              = coalesce(excluded.name, public.parts.name),
          compatible_models = coalesce(excluded.compatible_models, public.parts.compatible_models),
          online_store      = case when v_has_online_store then excluded.online_store
                                   else public.parts.online_store end,
          updated_at        = now()
    returning (xmax = 0) as was_inserted
  )
  select count(*) filter (where was_inserted), count(*) filter (where not was_inserted)
    into v_inserted, v_updated
    from upserted;

  return json_build_object('inserted', v_inserted, 'updated', v_updated);
end;
$$;

revoke all on function public.import_parts(jsonb, boolean, uuid[]) from public, anon;
grant execute on function public.import_parts(jsonb, boolean, uuid[]) to authenticated;

-- ------------------------------------------------------------
-- transfer_part_stock() — priedo kiekio perkėlimas į kitą vietą (bet kuris
-- sandėlis + lokacija). Bendras kiekis nesikeičia, tad pakanka 'edit' teisės.
-- Atomiška, šaltinio eilutė užrakinama:
--  * tikslinėje vietoje TAS PATS kodas jau yra → kiekiai sudedami;
--    perkėlus VISĄ kiekį šaltinis ištrinamas (dvi eilutės susilieja), o jo
--    nurašymų istorija (parts_writeoffs) perkeliama į tikslą, kad
--    neišsitrintų (FK on delete cascade);
--  * tikslinėje vietoje kodo nėra ir perkeliamas VISAS kiekis → tiesiog
--    pakeičiamas šaltinio sandėlis/lokacija (id ir istorija lieka);
--  * perkeliama DALIS į naują vietą → sukuriama nauja eilutė su šaltinio
--    duomenimis (pavadinimas, modelis, kaina, min. likutis ir t.t.).
-- Grąžina tikslinės parts eilutės id.
-- ------------------------------------------------------------
create or replace function public.transfer_part_stock(
  p_part_id uuid,
  p_to_warehouse_id uuid,
  p_to_location text,
  p_quantity integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src        public.parts%rowtype;
  v_location   text := trim(coalesce(p_to_location, ''));
  v_target_id  uuid;
begin
  if not public.has_permission(auth.uid(), 'edit') then
    raise exception 'Neturite teisės perkelti priedų.';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Perkeliamas kiekis turi būti didesnis už nulį.';
  end if;

  if v_location = '' then
    raise exception 'Įveskite lokaciją.';
  end if;

  if not exists (select 1 from public.warehouses where id = p_to_warehouse_id) then
    raise exception 'Sandėlis nerastas.';
  end if;

  select * into v_src from public.parts where id = p_part_id for update;
  if v_src.id is null then
    raise exception 'Priedas nerastas.';
  end if;
  if p_quantity > v_src.quantity then
    raise exception 'Perkeliamas kiekis (%) negali viršyti turimo likučio (%).', p_quantity, v_src.quantity;
  end if;

  -- Priedas be numerio (N/A) niekada nejungiamas su kitu (kiti N/A — kiti daiktai).
  select id into v_target_id
    from public.parts
    where warehouse_id = p_to_warehouse_id
      and public.lt_lower(trim(location)) = public.lt_lower(v_location)
      and public.lt_lower(trim(part_code)) = public.lt_lower(trim(v_src.part_code))
      and lower(trim(v_src.part_code)) not in ('', 'n/a', 'na', '-')
    for update;

  if v_target_id = p_part_id then
    raise exception 'Perkelti į tą pačią vietą negalima.';
  end if;

  if v_target_id is not null then
    update public.parts set quantity = quantity + p_quantity where id = v_target_id;
    if p_quantity = v_src.quantity then
      update public.parts_writeoffs set part_id = v_target_id where part_id = p_part_id;
      delete from public.parts where id = p_part_id;
    else
      update public.parts set quantity = quantity - p_quantity where id = p_part_id;
    end if;
    return v_target_id;
  end if;

  if p_quantity = v_src.quantity then
    update public.parts
      set warehouse_id = p_to_warehouse_id, location = v_location
      where id = p_part_id;
    return p_part_id;
  end if;

  update public.parts set quantity = quantity - p_quantity where id = p_part_id;

  insert into public.parts (warehouse_id, location, main_model, part_code, name, quantity,
                            min_quantity, online_store, compatible_models, notes, price)
  values (p_to_warehouse_id, v_location, v_src.main_model, v_src.part_code, v_src.name, p_quantity,
          v_src.min_quantity, v_src.online_store, v_src.compatible_models, v_src.notes, v_src.price)
  returning id into v_target_id;

  return v_target_id;
end;
$$;

revoke all on function public.transfer_part_stock(uuid, uuid, text, integer) from public, anon;
grant execute on function public.transfer_part_stock(uuid, uuid, text, integer) to authenticated;

-- ------------------------------------------------------------
-- (migrate_device_stock_location_ci.sql)
--
-- Prietaiso likučio lokacija — kaip priedų (migrate_part_unique_and_transfer.sql):
-- tas pats prietaisas tame pačiame sandėlyje gali turėti TIK vieną eilutę
-- lokacijai, neatsižvelgiant į raidžių dydį ir tarpus kraštuose ("a2" = "A2 ").
-- Anksčiau unikalumas buvo pagal tikslų tekstą (device_stock_device_warehouse_location_unique).
-- Jei DB jau yra tokių "dublikatų", indekso kūrimas nutrūks — surasti juos:
--   select device_id, warehouse_id, lt_lower(trim(location)), count(*)
--     from device_stock group by 1, 2, 3 having count(*) > 1;
--
-- Perrašomos visos funkcijos, kurių ON CONFLICT rėmėsi senuoju apribojimu:
-- undo_device_writeoff(), import_devices(), transfer_device_stock().
-- ------------------------------------------------------------

create unique index if not exists device_stock_device_warehouse_location_ci_unique
  on public.device_stock (device_id, warehouse_id, public.lt_lower(trim(location)));

alter table public.device_stock
  drop constraint if exists device_stock_device_warehouse_location_unique;

-- ------------------------------------------------------------
-- undo_device_writeoff() — tik naujas ON CONFLICT taikinys.
-- ------------------------------------------------------------
create or replace function public.undo_device_writeoff(p_writeoff_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device_id    uuid;
  v_warehouse_id uuid;
  v_location     text;
  v_quantity     integer;
  v_undone       timestamptz;
begin
  if not public.has_device_permission(auth.uid(), 'delete') then
    raise exception 'Neturite teisės atšaukti nurašymo.';
  end if;

  select device_id, warehouse_id, location, quantity, undone_at
    into v_device_id, v_warehouse_id, v_location, v_quantity, v_undone
    from public.device_writeoffs
    where id = p_writeoff_id
    for update;

  if v_location is null then
    raise exception 'Nurašymas nerastas.';
  end if;
  if v_undone is not null then
    raise exception 'Šis nurašymas jau atšauktas.';
  end if;
  if v_device_id is null then
    raise exception 'Prietaisas ištrintas — nurašymo atšaukti nebegalima.';
  end if;
  if v_warehouse_id is null then
    raise exception 'Sandėlis nežinomas (senas įrašas be sandėlio) — nurašymo atšaukti nebegalima.';
  end if;

  insert into public.device_stock (device_id, warehouse_id, location, quantity)
  values (v_device_id, v_warehouse_id, v_location, v_quantity)
  on conflict (device_id, warehouse_id, public.lt_lower(trim(location))) do update
    set quantity = public.device_stock.quantity + excluded.quantity,
        updated_at = now();

  update public.device_writeoffs
    set undone_at = now(), undone_by = auth.uid()
    where id = p_writeoff_id;

  update public.device_pickups
    set writeoff_id = null
    where writeoff_id = p_writeoff_id;
end;
$$;

grant execute on function public.undo_device_writeoff(uuid) to authenticated;

-- ------------------------------------------------------------
-- import_devices() — tik naujas ON CONFLICT taikinys (visa kita identiška
-- migrate_search_lt_fold.sql versijai).
-- ------------------------------------------------------------
create or replace function public.import_devices(rows jsonb, p_clear_existing boolean default false)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  r              jsonb;
  v_ian          text;
  v_warehouse    text;
  v_warehouse_id uuid;
  v_location     text;
  v_device_id    uuid;
  device_count   integer := 0;
  stock_count    integer := 0;
  skipped_count  integer := 0;
begin
  if not public.has_device_permission(auth.uid(), 'import') then
    raise exception 'Neturite prietaisų importo teisės.';
  end if;

  if p_clear_existing then
    if not public.has_device_permission(auth.uid(), 'delete') then
      raise exception 'Norint prieš importą išvalyti esamus duomenis, reikia trynimo teisės.';
    end if;
    delete from public.devices;
  end if;

  for r in select * from jsonb_array_elements(rows)
  loop
    v_ian := nullif(trim(r->>'ian'), '');
    if v_ian is null then
      skipped_count := skipped_count + 1;
      continue;
    end if;

    v_warehouse := nullif(trim(r->>'warehouse'), '');
    v_warehouse_id := null;
    if v_warehouse is not null then
      select id into v_warehouse_id from public.warehouses
        where public.lt_lower(trim(name)) = public.lt_lower(v_warehouse);
    end if;
    if v_warehouse_id is null then
      skipped_count := skipped_count + 1;
      continue;
    end if;

    insert into public.devices (ian, name, manufacturer, notes)
    values (v_ian, nullif(r->>'name', ''), nullif(r->>'manufacturer', ''), nullif(r->>'notes', ''))
    on conflict (ian) do update
      set name = coalesce(excluded.name, public.devices.name),
          manufacturer = coalesce(excluded.manufacturer, public.devices.manufacturer),
          notes = coalesce(excluded.notes, public.devices.notes),
          updated_at = now()
    returning id into v_device_id;

    device_count := device_count + 1;

    v_location := coalesce(nullif(trim(r->>'location'), ''), '-');

    insert into public.device_stock (device_id, warehouse_id, location, quantity)
    values (
      v_device_id,
      v_warehouse_id,
      v_location,
      coalesce((r->>'quantity')::integer, 0)
    )
    on conflict (device_id, warehouse_id, public.lt_lower(trim(location))) do update
      set quantity = excluded.quantity,
          updated_at = now();

    stock_count := stock_count + 1;
  end loop;

  return json_build_object(
    'devices', device_count,
    'stock_rows', stock_count,
    'skipped', skipped_count
  );
end;
$$;

grant execute on function public.import_devices(jsonb, boolean) to authenticated;

-- ------------------------------------------------------------
-- transfer_device_stock() — naujas ON CONFLICT taikinys IR "ta pati vieta"
-- tikrinama be raidžių dydžio: kitaip "A2" → "a2" per ON CONFLICT
-- atnaujintų PAČIĄ šaltinio eilutę, o perkėlus visą kiekį ji būtų ištrinta.
-- ------------------------------------------------------------
create or replace function public.transfer_device_stock(
  p_from_stock_id uuid,
  p_to_warehouse_id uuid,
  p_to_location text,
  p_quantity integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device_id      uuid;
  v_from_wh        uuid;
  v_from_location  text;
  v_from_qty       integer;
  v_to_location    text := coalesce(nullif(trim(p_to_location), ''), '-');
  v_to_stock_id    uuid;
  v_to_wh_name     text;
  v_reserved       integer;
begin
  if not public.has_device_permission(auth.uid(), 'edit') then
    raise exception 'Neturite teisės perkelti prietaisų.';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Perkeliamas kiekis turi būti didesnis už nulį.';
  end if;

  select device_id, warehouse_id, location, quantity
    into v_device_id, v_from_wh, v_from_location, v_from_qty
    from public.device_stock
    where id = p_from_stock_id
    for update;

  if v_device_id is null then
    raise exception 'Likutis nerastas.';
  end if;
  if p_quantity > v_from_qty then
    raise exception 'Perkeliamas kiekis (%) negali viršyti turimo likučio (%).', p_quantity, v_from_qty;
  end if;

  select name into v_to_wh_name from public.warehouses where id = p_to_warehouse_id;
  if v_to_wh_name is null then
    raise exception 'Sandėlis nerastas.';
  end if;

  if p_to_warehouse_id = v_from_wh
     and public.lt_lower(v_to_location) = public.lt_lower(trim(v_from_location)) then
    raise exception 'Perkelti į tą pačią vietą negalima.';
  end if;

  select coalesce(sum(quantity), 0) into v_reserved
    from public.device_pickups
    where picked_stock_id = p_from_stock_id and writeoff_id is null;

  if p_quantity < v_from_qty and v_from_qty - p_quantity < v_reserved then
    raise exception 'Iš šios vietos jau pažymėta „Paimta“ % vnt. — joje turi likti bent tiek (galima perkelti daugiausia % vnt. arba visą kiekį).',
      v_reserved, greatest(v_from_qty - v_reserved, 0);
  end if;

  insert into public.device_stock (device_id, warehouse_id, location, quantity)
  values (v_device_id, p_to_warehouse_id, v_to_location, p_quantity)
  on conflict (device_id, warehouse_id, public.lt_lower(trim(location))) do update
    set quantity = public.device_stock.quantity + excluded.quantity,
        updated_at = now()
  returning id, location into v_to_stock_id, v_to_location;

  if p_quantity = v_from_qty then
    update public.device_pickups
      set picked_stock_id = v_to_stock_id,
          picked_location = v_to_location,
          picked_warehouse_name = v_to_wh_name
      where picked_stock_id = p_from_stock_id and writeoff_id is null;

    delete from public.device_stock where id = p_from_stock_id;
  else
    update public.device_stock
      set quantity = quantity - p_quantity
      where id = p_from_stock_id;
  end if;

  return v_to_stock_id;
end;
$$;

revoke all on function public.transfer_device_stock(uuid, uuid, text, integer) from public, anon;
grant execute on function public.transfer_device_stock(uuid, uuid, text, integer) to authenticated;

-- ------------------------------------------------------------
-- (migrate_parts_split_stock.sql)
-- migrate_device_stock_location_ci.sql.
--
-- Priedai perdaromi kaip prietaisai (devices + device_stock):
--   parts       — priedų KATALOGAS: vienas įrašas vienam priedui (kodas,
--                 pavadinimas, modelis, suderinami modeliai, el. p-vė, kaina,
--                 min. likutis — BENDRAM kiekiui, pastaba);
--   part_stock  — kiek to priedo yra kiekvienoje vietoje (sandėlis +
--                 lokacija + kiekis).
--
-- Priedo tapatybė (parts.ident, žr. part_ident()):
--   * turi numerį → pagal kodą (be raidžių dydžio/tarpų);
--   * be numerio ("N/A", tuščias, "-") → pagal pavadinimą + pagrindinį
--     modelį (N/A priedai su skirtingais pavadinimais — skirtingi daiktai);
--   * nei numerio, nei pavadinimo → niekada nejungiamas su kitu.
--
-- Esamų duomenų perkėlimas: tos pačios tapatybės eilutės sujungiamos į vieną
-- katalogo įrašą (seniausias lieka), jų vietos tampa part_stock eilutėmis
-- (ta pati vieta — kiekiai sudedami). Katalogo laukai imami iš pirmos
-- netuščios reikšmės (seniausios eilutės pirma); el. p-vė — "taip", jei bent
-- vienoje vietoje buvo "taip"; pastabos, kurios ne visose vietose vienodos,
-- sujungiamos su lokacijos priešdėliu ("43 (-8-): ..."). Nurašymų istorija perkeliama į likusį įrašą,
-- o kiekvienas nurašymas gauna savo sandėlio/lokacijos kopiją.
--
-- Prieš keitimą padaromos atsarginės kopijos: parts_backup_20260925,
-- parts_writeoffs_backup_20260925 (RLS įjungtas, be politikų — per API
-- nepasiekiamos). Ištrinti, kai viskas patikrinta.
-- ------------------------------------------------------------

-- 0) Atsarginės kopijos
create table if not exists public.parts_backup_20260925 as table public.parts;
alter table public.parts_backup_20260925 enable row level security;
create table if not exists public.parts_writeoffs_backup_20260925 as table public.parts_writeoffs;
alter table public.parts_writeoffs_backup_20260925 enable row level security;

-- 1) Priedo tapatybė
create or replace function public.part_ident(p_code text, p_name text, p_model text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when public.lt_lower(trim(coalesce(p_code, ''))) not in ('', 'n/a', 'na', '-')
      then 'c:' || public.lt_lower(trim(p_code))
    when trim(coalesce(p_name, '')) <> ''
      then 'n:' || public.lt_lower(trim(p_name)) || '|' || public.lt_lower(trim(coalesce(p_model, '')))
  end;
$$;

alter table public.parts
  add column if not exists ident text
  generated always as (public.part_ident(part_code, name, main_model)) stored;

-- 2) part_stock
create table if not exists public.part_stock (
  id            uuid primary key default gen_random_uuid(),
  part_id       uuid not null references public.parts (id) on delete cascade,
  warehouse_id  uuid not null references public.warehouses (id),
  location      text not null,
  quantity      integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint part_stock_quantity_check check (quantity >= 0)
);

comment on table public.part_stock is 'Priedo kiekis konkrečioje lokacijoje konkrečiame sandėlyje. Vienas (part_id, warehouse_id, lokacija be raidžių dydžio) — viena eilutė.';

create unique index if not exists part_stock_part_warehouse_location_unique
  on public.part_stock (part_id, warehouse_id, public.lt_lower(trim(location)));
create index if not exists part_stock_part_id_idx on public.part_stock (part_id);
create index if not exists part_stock_warehouse_id_idx on public.part_stock (warehouse_id);
create index if not exists part_stock_location_idx on public.part_stock (location);

drop trigger if exists part_stock_set_updated_at on public.part_stock;
create trigger part_stock_set_updated_at
  before update on public.part_stock
  for each row execute function public.set_updated_at();

alter table public.part_stock enable row level security;

drop policy if exists "Vieša priedų likučių peržiūra" on public.part_stock;
create policy "Vieša priedų likučių peržiūra"
  on public.part_stock for select
  to anon, authenticated
  using (true);

drop policy if exists "Priedų likučių kūrimas pagal 'edit' teisę" on public.part_stock;
create policy "Priedų likučių kūrimas pagal 'edit' teisę"
  on public.part_stock for insert
  to authenticated
  with check (public.has_permission(auth.uid(), 'edit'));

drop policy if exists "Priedų likučių atnaujinimas pagal 'edit' teisę" on public.part_stock;
create policy "Priedų likučių atnaujinimas pagal 'edit' teisę"
  on public.part_stock for update
  to authenticated
  using (public.has_permission(auth.uid(), 'edit'))
  with check (public.has_permission(auth.uid(), 'edit'));

-- Vietos pašalinimas = tas pats, kas kiekio nustatymas į 0 ('edit' tai jau
-- leidžia), tad pakanka 'edit'. Viso priedo trynimas lieka 'delete'.
drop policy if exists "Priedų likučių trynimas pagal 'edit' teisę" on public.part_stock;
create policy "Priedų likučių trynimas pagal 'edit' teisę"
  on public.part_stock for delete
  to authenticated
  using (public.has_permission(auth.uid(), 'edit'));

-- 3) Nurašymai gauna savo sandėlio/lokacijos kopiją (kaip device_writeoffs)
alter table public.parts_writeoffs
  add column if not exists warehouse_id uuid references public.warehouses (id),
  add column if not exists location text;

update public.parts_writeoffs w
  set warehouse_id = p.warehouse_id, location = p.location
  from public.parts p
  where p.id = w.part_id and w.location is null;

-- 4) Esamų eilučių sujungimas pagal tapatybę
drop table if exists _part_map;
create temp table _part_map as
select
  id,
  case
    when ident is null then id
    else first_value(id) over (partition by ident order by created_at, id)
  end as canon
from public.parts;

update public.parts c
  set name              = m.name,
      main_model        = m.main_model,
      compatible_models = m.compatible_models,
      online_store      = m.online_store,
      price             = m.price,
      min_quantity      = m.min_quantity,
      notes             = m.notes
  from (
    select
      mp.canon,
      (array_agg(p.name order by p.created_at, p.id) filter (where nullif(trim(p.name), '') is not null))[1] as name,
      (array_agg(p.main_model order by p.created_at, p.id) filter (where nullif(trim(p.main_model), '') is not null))[1] as main_model,
      (array_agg(p.compatible_models order by p.created_at, p.id) filter (where nullif(trim(p.compatible_models), '') is not null))[1] as compatible_models,
      bool_or(p.online_store) as online_store,
      (array_agg(p.price order by p.created_at, p.id) filter (where p.price is not null))[1] as price,
      (array_agg(p.min_quantity order by p.created_at, p.id) filter (where p.min_quantity is not null))[1] as min_quantity,
      -- Visose vietose ta pati pastaba (arba jokios) — paliekama kaip yra;
      -- kitaip kiekviena pastaba gauna savo lokacijos priešdėlį, nes ji
      -- aprašė konkrečią vietą.
      case
        when count(distinct nullif(trim(p.notes), '')) <= 1
             and (count(nullif(trim(p.notes), '')) = 0 or count(nullif(trim(p.notes), '')) = count(*))
          then max(nullif(trim(p.notes), ''))
        else
          string_agg(trim(p.location) || ': ' || trim(p.notes), E'\n' order by p.created_at, p.id)
            filter (where nullif(trim(p.notes), '') is not null)
      end as notes
    from public.parts p
    join _part_map mp on mp.id = p.id
    group by mp.canon
    having count(*) > 1
  ) m
  where c.id = m.canon;

-- Kitų sujungtų eilučių pagrindiniai modeliai neprarandami — pridedami prie
-- suderinamų modelių (naujoje eilutėje), jei jų ten dar nėra.
update public.parts c
  set compatible_models = concat_ws(E'\n', nullif(trim(c.compatible_models), ''), x.extra)
  from (
    select mp.canon, string_agg(distinct trim(p.main_model), E'\n') as extra
    from public.parts p
    join _part_map mp on mp.id = p.id and mp.canon <> mp.id
    join public.parts k on k.id = mp.canon
    where nullif(trim(p.main_model), '') is not null
      and public.lt_lower(trim(p.main_model)) <> public.lt_lower(trim(coalesce(k.main_model, '')))
      and strpos(public.lt_lower(coalesce(k.compatible_models, '')), public.lt_lower(trim(p.main_model))) = 0
    group by mp.canon
  ) x
  where c.id = x.canon;

insert into public.part_stock (part_id, warehouse_id, location, quantity, created_at)
select
  mp.canon,
  p.warehouse_id,
  (array_agg(trim(p.location) order by p.created_at, p.id))[1],
  sum(p.quantity)::integer,
  min(p.created_at)
from public.parts p
join _part_map mp on mp.id = p.id
group by mp.canon, p.warehouse_id, public.lt_lower(trim(p.location));

update public.parts_writeoffs w
  set part_id = mp.canon
  from _part_map mp
  where mp.id = w.part_id and mp.canon <> mp.id;

delete from public.parts p
  using _part_map mp
  where mp.id = p.id and mp.canon <> p.id;

drop table _part_map;

create unique index if not exists parts_ident_unique on public.parts (ident);

-- 5) Vietos/kiekio stulpeliai iš katalogo pašalinami
drop index if exists public.parts_warehouse_location_code_unique;
alter table public.parts
  drop column if exists stock_level,
  drop column if exists quantity,
  drop column if exists location,
  drop column if exists warehouse_id;

comment on table public.parts is 'Priedų katalogas — vienas įrašas vienam priedui (be kiekio/lokacijos; tai part_stock).';

-- 6) part_totals — bendras kiekis per visas vietas + mažo likučio būsena.
-- security_invoker=true — paveldi parts/part_stock RLS (žr. device_totals).
create or replace view public.part_totals
with (security_invoker = true)
as
select
  p.id,
  p.part_code,
  p.name,
  p.main_model,
  p.compatible_models,
  p.online_store,
  p.price,
  p.min_quantity,
  p.notes,
  p.search_text,
  coalesce(sum(s.quantity), 0)::integer as total_quantity,
  count(s.id)::integer as location_count,
  min(s.location) as sort_location,
  -- Filtrams /priedai puslapyje (be atskiro id sąrašo užklausos):
  -- sandėlis — .contains("warehouse_ids", [id]); lokacijos "dėžė" —
  -- locations_text ilike "*|8|*" arba "*|8 *" ("|" skiria vietas).
  coalesce(array_agg(distinct s.warehouse_id) filter (where s.warehouse_id is not null), '{}') as warehouse_ids,
  '|' || coalesce(string_agg(trim(s.location), '|'), '') || '|' as locations_text,
  case
    when coalesce(sum(s.quantity), 0) <= 0 then 'out'
    when coalesce(sum(s.quantity), 0) <= coalesce(p.min_quantity, 3) then 'low'
    else 'ok'
  end as stock_level
from public.parts p
left join public.part_stock s on s.part_id = p.id
group by p.id;

comment on view public.part_totals is 'Kiekvieno priedo bendras kiekis per visas vietas + stock_level (out/low/ok). security_invoker=true.';

grant select on public.part_totals to anon, authenticated;

-- 7) import_parts() — kiekviena eilutė: priedas randamas/sukuriamas pagal
-- tapatybę (katalogo laukai atnaujinami tik netuščiomis reikšmėmis;
-- online_store — tik jei stulpelis susietas), o jo vietos kiekis
-- PERRAŠOMAS failo reikšme. Tas pats priedas toje pačioje vietoje faile
-- kelis kartus — kiekiai sudedami (front-end tai daro per visą failą).
-- clear_existing — išvalo nurodytų sandėlių VIETAS; priedai, kuriems
-- nebeliko jokios vietos IR neturintys nurašymų istorijos, ištrinami.
-- Grąžina {inserted, updated, parts_created, skipped}: inserted/updated —
-- vietų (part_stock) eilutės.
-- ------------------------------------------------------------
drop function if exists public.import_parts(jsonb, boolean, uuid[]);

create or replace function public.import_parts(
  rows jsonb,
  clear_existing boolean default false,
  p_clear_warehouse_ids uuid[] default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted       integer;
  v_updated        integer;
  v_parts_created  integer;
  v_total          integer;
  v_valid          integer;
  v_has_online_store boolean := exists (
    select 1 from jsonb_array_elements(rows) as r where r ? 'online_store'
  );
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
    delete from public.part_stock where warehouse_id = any (p_clear_warehouse_ids);
    delete from public.parts p
      where not exists (select 1 from public.part_stock s where s.part_id = p.id)
        and not exists (select 1 from public.parts_writeoffs w where w.part_id = p.id);
  end if;

  create temp table _imp on commit drop as
  select
    ord,
    w.id as warehouse_id,
    trim(r->>'location') as location,
    trim(r->>'part_code') as part_code,
    nullif(trim(r->>'main_model'), '') as main_model,
    nullif(trim(r->>'name'), '') as name,
    coalesce((r->>'quantity')::integer, 0) as quantity,
    coalesce((r->>'online_store')::boolean, false) as online_store,
    nullif(trim(r->>'compatible_models'), '') as compatible_models,
    public.part_ident(r->>'part_code', r->>'name', r->>'main_model') as ident
  from jsonb_array_elements(rows) with ordinality as t(r, ord)
  join public.warehouses w
    on public.lt_lower(trim(w.name)) = public.lt_lower(trim(r->>'warehouse'))
  where nullif(trim(r->>'location'), '') is not null;

  select count(*) into v_total from jsonb_array_elements(rows);
  select count(*) into v_valid from _imp where ident is not null;

  -- a) katalogas
  with grouped as (
    select
      ident,
      (array_agg(part_code order by ord))[1] as part_code,
      (array_agg(name order by ord) filter (where name is not null))[1] as name,
      (array_agg(main_model order by ord) filter (where main_model is not null))[1] as main_model,
      (array_agg(compatible_models order by ord) filter (where compatible_models is not null))[1] as compatible_models,
      bool_or(online_store) as online_store
    from _imp
    where ident is not null
    group by ident
  ),
  upserted as (
    insert into public.parts (part_code, name, main_model, compatible_models, online_store)
    select coalesce(nullif(part_code, ''), 'N/A'), name, main_model, compatible_models, online_store
    from grouped
    on conflict (ident) do update
      set name              = coalesce(excluded.name, public.parts.name),
          main_model        = coalesce(excluded.main_model, public.parts.main_model),
          compatible_models = coalesce(excluded.compatible_models, public.parts.compatible_models),
          online_store      = case when v_has_online_store then excluded.online_store
                                   else public.parts.online_store end,
          updated_at        = now()
    returning (xmax = 0) as was_inserted
  )
  select count(*) filter (where was_inserted) into v_parts_created from upserted;

  -- b) vietos
  with stock as (
    select
      p.id as part_id,
      i.warehouse_id,
      (array_agg(i.location order by i.ord))[1] as location,
      sum(i.quantity)::integer as quantity
    from _imp i
    join public.parts p on p.ident = i.ident
    group by p.id, i.warehouse_id, public.lt_lower(i.location)
  ),
  upserted as (
    insert into public.part_stock (part_id, warehouse_id, location, quantity)
    select part_id, warehouse_id, location, quantity from stock
    on conflict (part_id, warehouse_id, public.lt_lower(trim(location))) do update
      set quantity = excluded.quantity,
          updated_at = now()
    returning (xmax = 0) as was_inserted
  )
  select count(*) filter (where was_inserted), count(*) filter (where not was_inserted)
    into v_inserted, v_updated
    from upserted;

  return json_build_object(
    'inserted', v_inserted,
    'updated', v_updated,
    'parts_created', v_parts_created,
    'skipped', v_total - v_valid
  );
end;
$$;

revoke all on function public.import_parts(jsonb, boolean, uuid[]) from public, anon;
grant execute on function public.import_parts(jsonb, boolean, uuid[]) to authenticated;

-- 8) transfer_part_stock() — kaip transfer_device_stock(): iš vienos vietos
-- (part_stock eilutės) į kitą to paties priedo vietą (kiekiai sudedami) arba
-- naują. Perkėlus visą kiekį šaltinio vieta ištrinama.
drop function if exists public.transfer_part_stock(uuid, uuid, text, integer);

create or replace function public.transfer_part_stock(
  p_from_stock_id uuid,
  p_to_warehouse_id uuid,
  p_to_location text,
  p_quantity integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_part_id        uuid;
  v_from_wh        uuid;
  v_from_location  text;
  v_from_qty       integer;
  v_to_location    text := trim(coalesce(p_to_location, ''));
  v_to_stock_id    uuid;
begin
  if not public.has_permission(auth.uid(), 'edit') then
    raise exception 'Neturite teisės perkelti priedų.';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Perkeliamas kiekis turi būti didesnis už nulį.';
  end if;

  if v_to_location = '' then
    raise exception 'Įveskite lokaciją.';
  end if;

  select part_id, warehouse_id, location, quantity
    into v_part_id, v_from_wh, v_from_location, v_from_qty
    from public.part_stock
    where id = p_from_stock_id
    for update;

  if v_part_id is null then
    raise exception 'Likutis nerastas.';
  end if;
  if p_quantity > v_from_qty then
    raise exception 'Perkeliamas kiekis (%) negali viršyti turimo likučio (%).', p_quantity, v_from_qty;
  end if;

  if not exists (select 1 from public.warehouses where id = p_to_warehouse_id) then
    raise exception 'Sandėlis nerastas.';
  end if;

  if p_to_warehouse_id = v_from_wh
     and public.lt_lower(v_to_location) = public.lt_lower(trim(v_from_location)) then
    raise exception 'Perkelti į tą pačią vietą negalima.';
  end if;

  insert into public.part_stock (part_id, warehouse_id, location, quantity)
  values (v_part_id, p_to_warehouse_id, v_to_location, p_quantity)
  on conflict (part_id, warehouse_id, public.lt_lower(trim(location))) do update
    set quantity = public.part_stock.quantity + excluded.quantity,
        updated_at = now()
  returning id into v_to_stock_id;

  if p_quantity = v_from_qty then
    delete from public.part_stock where id = p_from_stock_id;
  else
    update public.part_stock set quantity = quantity - p_quantity where id = p_from_stock_id;
  end if;

  return v_to_stock_id;
end;
$$;

revoke all on function public.transfer_part_stock(uuid, uuid, text, integer) from public, anon;
grant execute on function public.transfer_part_stock(uuid, uuid, text, integer) to authenticated;

-- 9) writeoff_part() — dabar nurašo iš konkrečios vietos (p_stock_id), kaip
-- writeoff_device(). Vieta, likus 0, NEištrinama (lieka matoma "0 vnt.").
drop function if exists public.writeoff_part(uuid, integer, text, numeric, text, text);

create or replace function public.writeoff_part(
  p_stock_id uuid,
  p_quantity integer,
  p_reason_type text,
  p_price numeric default null,
  p_rma text default null,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_part_id      uuid;
  v_warehouse_id uuid;
  v_location     text;
  v_current_qty  integer;
begin
  if not public.has_permission(auth.uid(), 'delete') then
    raise exception 'Neturite nurašymo teisės.';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Nurašomas kiekis turi būti didesnis už nulį.';
  end if;

  if p_reason_type not in ('parduota', 'remontui', 'kita') then
    raise exception 'Neteisinga nurašymo priežastis.';
  end if;

  if p_reason_type = 'parduota' and (p_price is null or p_price <= 0) then
    raise exception 'Įveskite kainą.';
  end if;

  if p_reason_type = 'remontui' and (p_rma is null or trim(p_rma) = '') then
    raise exception 'Įveskite RMA numerį.';
  end if;

  if p_reason_type = 'kita' and (p_reason is null or trim(p_reason) = '') then
    raise exception 'Įveskite priežastį.';
  end if;

  select part_id, warehouse_id, location, quantity
    into v_part_id, v_warehouse_id, v_location, v_current_qty
    from public.part_stock
    where id = p_stock_id
    for update;
  if v_part_id is null then
    raise exception 'Likutis nerastas.';
  end if;
  if p_quantity > v_current_qty then
    raise exception 'Nurašomas kiekis (%) negali viršyti turimo likučio (%).', p_quantity, v_current_qty;
  end if;

  update public.part_stock set quantity = quantity - p_quantity where id = p_stock_id;

  insert into public.parts_writeoffs (part_id, warehouse_id, location, user_id, quantity, reason_type, price, rma, reason)
  values (
    v_part_id,
    v_warehouse_id,
    v_location,
    auth.uid(),
    p_quantity,
    p_reason_type,
    case when p_reason_type = 'parduota' then p_price else null end,
    case when p_reason_type = 'remontui' then nullif(trim(p_rma), '') else null end,
    case when p_reason_type = 'kita' then nullif(trim(p_reason), '') else null end
  );
end;
$$;

grant execute on function public.writeoff_part(uuid, integer, text, numeric, text, text) to authenticated;

-- 10) undo_writeoff() — kiekis grąžinamas į nurašymo vietą (jei jos
-- nebėra — sukuriama iš naujo), kaip undo_device_writeoff().
create or replace function public.undo_writeoff(p_writeoff_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_part_id      uuid;
  v_warehouse_id uuid;
  v_location     text;
  v_quantity     integer;
  v_undone       timestamptz;
begin
  if not public.has_permission(auth.uid(), 'delete') then
    raise exception 'Neturite teisės atšaukti nurašymo.';
  end if;

  select part_id, warehouse_id, location, quantity, undone_at
    into v_part_id, v_warehouse_id, v_location, v_quantity, v_undone
    from public.parts_writeoffs
    where id = p_writeoff_id
    for update;

  if v_part_id is null then
    raise exception 'Nurašymas nerastas.';
  end if;
  if v_undone is not null then
    raise exception 'Šis nurašymas jau atšauktas.';
  end if;
  if v_warehouse_id is null or v_location is null then
    raise exception 'Nežinoma nurašymo vieta — atšaukti nebegalima.';
  end if;

  insert into public.part_stock (part_id, warehouse_id, location, quantity)
  values (v_part_id, v_warehouse_id, v_location, v_quantity)
  on conflict (part_id, warehouse_id, public.lt_lower(trim(location))) do update
    set quantity = public.part_stock.quantity + excluded.quantity,
        updated_at = now();

  update public.parts_writeoffs
    set undone_at = now(), undone_by = auth.uid()
    where id = p_writeoff_id;
end;
$$;

grant execute on function public.undo_writeoff(uuid) to authenticated;

-- 11) parts_stats() — sandėlio būklė iš part_totals (bendras kiekis per
-- vietas), ne iš atskirų eilučių. Sena vieno parametro versija (iki
-- laikotarpio "nuo–iki") pašalinama, kad RPC nebūtų dviprasmiškas.
drop function if exists public.parts_stats(timestamptz);

create or replace function public.parts_stats(p_from timestamptz default null, p_to timestamptz default null)
returns jsonb
language sql
stable
set search_path = public
as $$
  with active as (
    select w.quantity, w.reason_type, w.price, p.part_code, p.name, p.main_model
    from public.parts_writeoffs w
    join public.parts p on p.id = w.part_id
    where w.undone_at is null
      and (p_from is null or w.created_at >= p_from)
      and (p_to is null or w.created_at < p_to)
  )
  select jsonb_build_object(
    'overview', (
      select jsonb_build_object(
        'total_parts',    count(*),
        'total_units',    coalesce(sum(total_quantity), 0),
        'low_count',      count(*) filter (where stock_level = 'low'),
        'out_count',      count(*) filter (where stock_level = 'out'),
        'location_count', (select count(*) from public.part_stock)
      )
      from public.part_totals
    ),
    'writeoffs', jsonb_build_object(
      'total_qty', (select coalesce(sum(quantity), 0) from active),
      'revenue',   (select coalesce(sum(price) filter (where reason_type = 'parduota'), 0) from active),
      'by_reason', (
        select coalesce(jsonb_object_agg(reason_type, jsonb_build_object('count', c, 'qty', q)), '{}'::jsonb)
        from (
          select reason_type, count(*) as c, sum(quantity) as q
          from active
          group by reason_type
        ) r
      )
    ),
    'top_items', (
      select coalesce(jsonb_agg(
        jsonb_build_object('label', label, 'code', part_code, 'model', model, 'qty', qty)
        order by qty desc, label
      ), '[]'::jsonb)
      from (
        select
          coalesce(nullif(name, ''), part_code) as label,
          part_code,
          min(main_model) as model,
          sum(quantity) as qty
        from active
        group by part_code, coalesce(nullif(name, ''), part_code)
        order by sum(quantity) desc, coalesce(nullif(name, ''), part_code)
        limit 5
      ) t
    )
  );
$$;

revoke all on function public.parts_stats(timestamptz, timestamptz) from public, anon;
grant execute on function public.parts_stats(timestamptz, timestamptz) to authenticated;

-- 12) Realtime
alter publication supabase_realtime add table public.part_stock;

-- ============================================================
-- KATALOGO VARIANTAI (žr. migrate_add_catalog_variants.sql)
-- ============================================================
create table if not exists public.catalog_variants (
  id         uuid primary key default gen_random_uuid(),
  ian        text not null references public.catalog (ian) on delete cascade on update cascade,
  name       text not null,
  raw_text   text,
  created_at timestamptz not null default now(),
  constraint catalog_variants_ian_name_unique unique (ian, name)
);

comment on table public.catalog_variants is 'Visi to paties IAN pavadinimai (daiktai). Gamintojas/tipas — catalog lentelėje.';

create index if not exists catalog_variants_ian_idx on public.catalog_variants (ian);

alter table public.catalog_variants enable row level security;

drop policy if exists "Vieša katalogo variantų peržiūra" on public.catalog_variants;
create policy "Vieša katalogo variantų peržiūra"
  on public.catalog_variants for select
  to anon, authenticated
  using (true);

drop policy if exists "Katalogo variantų kūrimas pagal 'scan' teisę" on public.catalog_variants;
create policy "Katalogo variantų kūrimas pagal 'scan' teisę"
  on public.catalog_variants for insert
  to authenticated
  with check (public.has_pallet_permission(auth.uid(), 'scan'));

drop policy if exists "Katalogo variantų atnaujinimas pagal 'scan' teisę" on public.catalog_variants;
create policy "Katalogo variantų atnaujinimas pagal 'scan' teisę"
  on public.catalog_variants for update
  to authenticated
  using (public.has_pallet_permission(auth.uid(), 'scan'))
  with check (public.has_pallet_permission(auth.uid(), 'scan'));

drop policy if exists "Katalogo variantų trynimas pagal 'scan' teisę" on public.catalog_variants;
create policy "Katalogo variantų trynimas pagal 'scan' teisę"
  on public.catalog_variants for delete
  to authenticated
  using (public.has_pallet_permission(auth.uid(), 'scan'));

-- Esamas katalogas: kiekvienas IAN gauna vieną variantą — dabartinį pavadinimą.
-- Kiti to paties IAN pavadinimai atsiras pakartotinai importavus katalogo failą.
insert into public.catalog_variants (ian, name, raw_text)
select ian, trim(name), raw_text
from public.catalog
where nullif(trim(name), '') is not null
on conflict (ian, name) do nothing;
