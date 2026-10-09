-- Paleisti Supabase Dashboard → SQL Editor
-- PALEIDIMO TVARKA: po migrate_part_unique_and_transfer.sql ir
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
