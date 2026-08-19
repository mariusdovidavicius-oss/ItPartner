-- ============================================================
-- DEVICES — prietaisų (įrangos) sandėlio modulis.
-- Nepriklausomas nuo items/pallets/shipments IR nuo parts (priedų) modulio —
-- turi savo teises (device_permissions), nesidalina su user_permissions
-- (parts) ar pallet_permissions, kaip ir tarp šių dviejų jau atskirta.
--
-- Excel šaltinis: A Prietaisas (pavadinimas) | B IAN | C Kiekis | D Lokacija |
-- E Komentaras | F Gamintojas. Tas pats IAN gali pasikartoti keliose
-- eilutėse — skiriasi tik kiekis/lokacija/komentaras (skirtingos to paties
-- modelio saugojimo vietos), todėl duomenys NORMALIZUOJAMI į dvi lenteles:
--
--   devices       — unikalus prietaiso MODELIS (IAN unikalus, pavadinimas,
--                    gamintojas). Vienas įrašas per modelį, nepriklausomai
--                    nuo to, kiek lokacijų jį turi.
--   device_stock  — kiek ir kur konkretaus modelio yra (device_id + lokacija
--                    = kiekis + pastaba). UNIQUE(device_id, location) —
--                    pakartotinis importas atnaujina esamą eilutę, o ne
--                    kuria dublikatą.
--
-- Komentaras (Excel E) saugomas device_stock lygmenyje, ne devices — nes jis
-- paprastai apibūdina konkretaus likučio būklę konkrečioje lokacijoje
-- (pvz. "dėžė pažeista" tik vienoje iš kelių lokacijų), ne patį modelį.
--
-- Peržiūra (SELECT) VIEŠA — kaip ir items/pallets/shipments/catalog/parts,
-- sąrašą mato bet kas be prisijungimo (žr. 4 skyrių žemiau). Redagavimas/
-- trynimas/nurašymas/importas ir toliau reikalauja prisijungimo + atitinkamos
-- teisės.
-- ============================================================

-- ------------------------------------------------------------
-- 1) devices — unikalus prietaiso modelis
-- ------------------------------------------------------------
create table if not exists public.devices (
  id            uuid primary key default gen_random_uuid(),
  ian           text not null unique,           -- "IAN" — identifikuoja MODELĮ, ne fizinį vienetą
  name          text,                            -- "Prietaisas"
  manufacturer  text,                            -- "Gamintojas" (šiuo metu: Grizzly, Kompernass — laisvas tekstas, ne enum, kad lengva pridėti naujus)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.devices is 'Unikalūs prietaisų modeliai (IAN → pavadinimas/gamintojas), be kiekio/lokacijos informacijos.';

create index if not exists devices_name_idx on public.devices (name);
create index if not exists devices_manufacturer_idx on public.devices (manufacturer);

drop trigger if exists devices_set_updated_at on public.devices;
create trigger devices_set_updated_at
  before update on public.devices
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- 2) device_stock — kiekis konkrečioje lokacijoje
-- ------------------------------------------------------------
create table if not exists public.device_stock (
  id          uuid primary key default gen_random_uuid(),
  device_id   uuid not null references public.devices (id) on delete cascade,
  location    text not null default '-',         -- "Lokacija" (laisvas tekstas, ne vien skaičiai)
  quantity    integer not null default 0,
  notes       text,                               -- "Komentaras" — konkretaus likučio pastaba
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint device_stock_quantity_check check (quantity >= 0),
  constraint device_stock_device_location_unique unique (device_id, location)
);

comment on table public.device_stock is 'Prietaiso kiekis konkrečioje lokacijoje. Vienas (device_id, location) turi tiksliai vieną eilutę.';

create index if not exists device_stock_device_id_idx on public.device_stock (device_id);
create index if not exists device_stock_location_idx on public.device_stock (location);

drop trigger if exists device_stock_set_updated_at on public.device_stock;
create trigger device_stock_set_updated_at
  before update on public.device_stock
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- 3) device_permissions — atskiras leidimų rinkinys šiam moduliui
-- (view/edit/delete/import), visiškai nepriklausomas nuo user_permissions
-- (parts) ir pallet_permissions. Naudoja tą patį bendrą is_admin() (žr.
-- migrate_add_parts_permissions.sql) kaip super-adminą, apeinantį visas
-- teises visuose moduliuose.
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 4) RLS: devices / device_stock — SELECT VIEŠAS (anon + authenticated,
-- kaip parts, žr. migrate_parts_public_view.sql); mutacijos ir toliau
-- reikalauja atitinkamos 'edit'/'delete' teisės (tik authenticated).
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 5) import_devices RPC — masinis Excel importas. Reikalauja 'import'
-- teisės. Kiekvienai eilutei: upsert į devices pagal IAN (jei IAN jau
-- egzistuoja — pavadinimas/gamintojas ATNAUJINAMI naujausia importo
-- reikšme), tada upsert į device_stock pagal (device_id, location)
-- (pakartotinis importas su ta pačia lokacija PERRAŠO kiekį/pastabą,
-- ne prideda dublikatą). Eilutės be IAN praleidžiamos (neįmanoma
-- identifikuoti modelio) — jų skaičius grąžinamas atskirai.
--
-- p_clear_existing=true prieš importą išvalo IR devices, IR device_stock
-- (reikalauja papildomai 'delete' teisės) — naudinga pilnam sandėlio
-- perskaičiavimui iš naujo Excel eksporto.
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

    insert into public.devices (ian, name, manufacturer)
    values (v_ian, nullif(r->>'name', ''), nullif(r->>'manufacturer', ''))
    on conflict (ian) do update
      set name = excluded.name,
          manufacturer = excluded.manufacturer,
          updated_at = now()
    returning id into v_device_id;

    device_count := device_count + 1;

    v_location := coalesce(nullif(trim(r->>'location'), ''), '-');

    insert into public.device_stock (device_id, location, quantity, notes)
    values (
      v_device_id,
      v_location,
      coalesce((r->>'quantity')::integer, 0),
      nullif(r->>'notes', '')
    )
    on conflict (device_id, location) do update
      set quantity = excluded.quantity,
          notes = excluded.notes,
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
-- 6) Realtime + bendras likutis per visas lokacijas (VIEW)
-- ------------------------------------------------------------
alter publication supabase_realtime add table public.devices;
alter publication supabase_realtime add table public.device_stock;

-- "security_invoker = true" — geroji praktika (Supabase linteris tai
-- pažymi) net kai pagrindinių lentelių SELECT yra viešas: be šios
-- parinkties VIEW pagal nutylėjimą vykdo RLS politikas VIEW SAVININKO
-- (Supabase atveju "postgres", turinčio BYPASSRLS) teisėmis, ne užklausą
-- siunčiančio vartotojo — su security_invoker=true view visada tiksliai
-- atspindi devices/device_stock RLS, koks jis bebūtų dabar ar ateityje.
create or replace view public.device_totals
with (security_invoker = true)
as
select
  d.id,
  d.ian,
  d.name,
  d.manufacturer,
  coalesce(sum(ds.quantity), 0)::integer as total_quantity,
  count(ds.id)::integer as location_count
from public.devices d
left join public.device_stock ds on ds.device_id = d.id
group by d.id, d.ian, d.name, d.manufacturer;

comment on view public.device_totals is 'Kiekvieno prietaiso bendras kiekis, susumuotas per visas lokacijas. security_invoker=true — vykdoma UŽKLAUSĖJO teisėmis, todėl paveldi devices/device_stock RLS (be šios parinkties view apeitų RLS per view savininko teises).';
