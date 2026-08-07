-- Paleisti Supabase Dashboard → SQL Editor
--
-- Scenarijus: 6 paletės jau "ready" (užsakytas kurjeris, jam pasakytas
-- skaičius 6). Kraunama nauja paletė kitam kartui — ji gauna "1" (nes
-- "ready" pažymėjimas jau atstatė darbinį skaitliuką). Ta paletė uždaroma
-- ("laukia paruošimo", rodoma kaip "1 paletė"). Bet kurjeris pasako, kad
-- gali paimti daugiau — ši paletė TAIP PAT pažymima "ready" ir prisijungia
-- prie jau esančių 6. Ji turi tapti "7 paletė" (o ne likti "1", kuris
-- susidurtų su tuo, kad viena paletė jau buvo "1" tarp pirmų šešių).
--
-- Sprendimas: pridedamas ATSKIRAS skaitliukas "ready eilės pozicijai"
-- (pallet_ready_counters), nepriklausomas nuo darbinio skaitliuko
-- (pallet_number_counters):
--   - Kiekviena paletė, tapdama "ready", PERNUMERUOJAMA (number/code)
--     pagal šį skaitliuką: pozicija = esamų neišsiųstų "ready" paletžų
--     tai paskirčiai skaičius + 1. Naudoja tą patį atominį upsert/increment
--     modelį kaip set_pallet_number() — korektiškai veikia ir masiniam
--     (bulk) kelių paletžų pažymėjimui vienu metu, nepriklausomai nuo
--     eilučių apdorojimo tvarkos.
--   - Ši "ready" pozicija atsistato į 0 TIK kai siunta realiai pažymima
--     "sent" (kurjeris pasiėmė) — ne anksčiau, nes kol siunta dar
--     nepasiimta, prie jos gali prisijungti daugiau paletžų.
--
-- Darbinio skaitliuko (pallet_number_counters) atstatymo trigeris taip pat
-- patikslinamas: atstato TIK kai tai PIRMA paletė, tampanti "ready" tai
-- paskirčiai (t. y. anksčiau nebuvo nė vienos "ready") — ne kiekvieną kartą,
-- kad prisijungimas prie jau esančio "ready" komplekto neatstatytų
-- skaitliuko jau NAUJAM, tuo metu galbūt besikaupiančiam ciklui.

-- ------------------------------------------------------------
-- 1) Patikslintas darbinio skaitliuko atstatymas — tik pirmai "ready" paletei
-- ------------------------------------------------------------
create or replace function public.reset_pallet_numbering_on_ready()
returns trigger as $$
declare
  v_existing_ready_count integer;
begin
  if new.status = 'ready' and old.status is distinct from 'ready' then
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

-- ------------------------------------------------------------
-- 2) Nauja lentelė "ready" eilės pozicijai
-- ------------------------------------------------------------
create table if not exists public.pallet_ready_counters (
  destination      text primary key,
  current_position integer not null default 0
);

comment on table public.pallet_ready_counters is
  'Kiekvienos destination dabartinė "paruošta išvežimui" eilės pozicija. Atskira nuo pallet_number_counters (darbinio, dar nepasiruošusioms paletėms numeruoti).';

alter table public.pallet_ready_counters enable row level security;
-- Jokių RLS policy nekuriame — lentelę valdo tik SECURITY DEFINER trigerio
-- funkcijos žemiau.

-- ------------------------------------------------------------
-- 3) Paletės pernumeravimas jai tampant "ready"
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 4) "Ready" pozicijos atstatymas, kai siunta REALIAI pažymima išsiųsta
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 5) reset_test_data() papildomas — kad testinių duomenų išvalymas
--    (/admin-reset) neliktų senų "ready" pozicijų.
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

  truncate table public.pallet_number_counters;
  truncate table public.pallet_ready_counters;

  return json_build_object('ok', true);
end;
$$;
