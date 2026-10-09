-- Paleisti Supabase Dashboard → SQL Editor
-- Prietaisų SANDĖLIAI (fizinės vietos) — naujas lygmuo VIRŠ jau esančios
-- device_stock.location (kuri lieka nepakitusi — laisvas tekstas konkrečios
-- lentynos/dėžės žymėjimui TO SANDĖLIO viduje). Vienas prietaisas gali būti
-- keliuose sandėliuose vienu metu — tai jau veikė per kelias device_stock
-- eilutes, sandėlis tiesiog tampa dar vienu tos eilutės lauku.
--
-- Peržiūra (SELECT) VIEŠA visiems (kaip ir devices/parts) — sandėlio
-- pavadinimas MATOMAS tik išskleidus prietaisą (front-end sprendimas, ne
-- RLS). Kurti/redaguoti/trinti sandėlius gali TIK adminas — importas jų
-- SAVAIME NEKURIA (žr. import_devices() žemiau — nerastas pavadinimas =
-- eilutė praleidžiama, ne sukuriamas naujas sandėlis).
--
-- Šios migracijos metu prietaisų/likučių DAR NĖRA (patvirtinta), todėl
-- device_stock.warehouse_id iškart daromas NOT NULL, be jokio "palikimo"
-- žingsnio. Jei kada nors reikėtų paleisti šią migraciją, kai device_stock
-- JAU turi eilučių, ALTER ... SET NOT NULL toliau esantis žingsnis aiškiai
-- nutrūks su klaida — tada pirma reikės rankiniu būdu priskirti sandėlį
-- esamoms eilutėms.
-- ------------------------------------------------------------

create table if not exists public.warehouses (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

comment on table public.warehouses is 'Fizinių prietaisų sandėlių sąrašas (vien pavadinimas). Kuria/trina TIK adminas.';

alter table public.warehouses enable row level security;

-- "create policy" neturi "if not exists" atitikmens PostgreSQL'e, todėl
-- saugiam pakartotiniam paleidimui apgaubiama sąlyga (žr. tą patį principą
-- žemiau dėl "alter publication" ir naujo unikalumo apribojimo).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'warehouses' and policyname = 'Vieša sandėlių peržiūra'
  ) then
    create policy "Vieša sandėlių peržiūra"
      on public.warehouses for select
      to anon, authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'warehouses' and policyname = 'Adminas tvarko sandėlius'
  ) then
    create policy "Adminas tvarko sandėlius"
      on public.warehouses for all
      to authenticated
      using (public.is_admin(auth.uid()))
      with check (public.is_admin(auth.uid()));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'warehouses'
  ) then
    alter publication supabase_realtime add table public.warehouses;
  end if;
end $$;

-- ------------------------------------------------------------
-- device_stock — naujas privalomas warehouse_id. Unikalumas keičiamas iš
-- (device_id, location) į (device_id, warehouse_id, location), nes ta pati
-- lokacija dabar gali kartotis skirtinguose sandėliuose.
-- ------------------------------------------------------------
alter table public.device_stock
  add column if not exists warehouse_id uuid references public.warehouses (id);

alter table public.device_stock
  alter column warehouse_id set not null;

alter table public.device_stock
  drop constraint if exists device_stock_device_location_unique;

-- "add constraint" taip pat neturi "if not exists" atitikmens.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'device_stock_device_warehouse_location_unique') then
    alter table public.device_stock
      add constraint device_stock_device_warehouse_location_unique unique (device_id, warehouse_id, location);
  end if;
end $$;

create index if not exists device_stock_warehouse_id_idx on public.device_stock (warehouse_id);

-- ------------------------------------------------------------
-- device_writeoffs — sandėlis funkciškai reikalingas undo_device_writeoff(),
-- kad žinotų, Į KURĮ sandėlį grąžinti kiekį (be jo location tekstas
-- nebeidentifikuoja vienareikšmiškai device_stock eilutės). NOT NULL, nes
-- kiekvienas BŪSIMAS nurašymas visada kils iš konkrečios (device_id,
-- warehouse_id, location) device_stock eilutės.
-- ------------------------------------------------------------
alter table public.device_writeoffs
  add column if not exists warehouse_id uuid references public.warehouses (id);

-- ------------------------------------------------------------
-- device_pickups — "paimta" žingsnis dabar fiksuoja KONKREČIĄ device_stock
-- eilutę (picked_stock_id), iš kurios bus nurašoma finalize_device_pickup()
-- metu — location teksto identifikavimo nebeužtenka (žr. aukščiau).
-- picked_warehouse_name — denormalizuota kopija (kaip ir device_writeoffs.
-- device_name/device_ian), kad sąrašas liktų skaitomas net jei kas nors
-- vėliau pakeistų/ištrintų susijusią device_stock eilutę.
-- ------------------------------------------------------------
alter table public.device_pickups
  add column if not exists picked_stock_id uuid references public.device_stock (id) on delete set null;
alter table public.device_pickups
  add column if not exists picked_warehouse_name text;

-- ------------------------------------------------------------
-- writeoff_device() — DABAR priima p_stock_id (device_stock.id) vietoj
-- p_device_id + p_location. Saugu paleisti pakartotinai: sena versija
-- (kitokiu parametrų sąrašu) pašalinama, kad neliktų dviejų to paties
-- vardo funkcijų.
-- ------------------------------------------------------------
drop function if exists public.writeoff_device(uuid, text, integer, text, numeric, text, text);

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

-- undo_device_writeoff() — grąžina kiekį pagal (device_id, warehouse_id,
-- location), ne vien location, kad atgautų teisingą sandėlį.
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
  on conflict (device_id, warehouse_id, location) do update
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

-- mark_device_picked() — DABAR priima p_stock_id vietoj p_location, ir
-- patikrina, kad tas likutis priklauso TAM PAČIAM prietaisui, kurio yra
-- sąrašo punktas. picked_location/picked_warehouse_name išlieka kaip teksto
-- kopija (rodymui), picked_stock_id — funkcinis ryšys finalize_device_pickup()
-- metu.
drop function if exists public.mark_device_picked(uuid, text);

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

-- finalize_device_pickup() — nurašo per picked_stock_id (ne per
-- device_id+location paiešką).
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

-- unpick_device_pickup() — papildomai išvalo picked_stock_id/picked_warehouse_name.
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

-- ------------------------------------------------------------
-- import_devices() — kiekviena eilutė DABAR privalo nurodyti sandėlio
-- pavadinimą (r->>'warehouse'). Sandėlis TURI JAU EGZISTUOTI (sukurtas
-- adminas) — importas jo savaime nekuria; nerastas pavadinimas = eilutė
-- praleidžiama (skipped_count), lygiai kaip ir trūkstamas IAN.
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
      select id into v_warehouse_id from public.warehouses where name = v_warehouse;
    end if;
    if v_warehouse_id is null then
      -- Sandėlis nenurodytas arba nerastas — eilutė praleidžiama (prietaisas
      -- kataloge NEATSIRANDA/neatsinaujina pagal šią eilutę), nes be sandėlio
      -- device_stock eilutės sukurti negalima (NOT NULL).
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
