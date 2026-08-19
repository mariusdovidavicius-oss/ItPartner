-- Paleisti Supabase Dashboard → SQL Editor
-- "Atsinešimų sąrašas" — garantinio serviso srautui: klientas atsiunčia
-- sugedusį prietaisą, Marius suranda IR pažymi, kad reikia atsinešti iš
-- sandėlio pakaitinį TO PATIES PAVADINIMO prietaisą (IAN dažniausiai
-- skiriasi — tai kitas fizinis vienetas). Šis įrašas pakeičia buvusį
-- rankinį sekimą Google Sheets ("ką atsinešti") IR Excel (nurašymo
-- žurnalas).
--
-- TRYS atskiri žingsniai/būsenos (SĄMONINGAI atskirti — fizinis daikto
-- paėmimas iš lentynos ir jo nurašymas iš apskaitos NĖRA tas pats momentas):
--   1) Laukia    — picked_at IS NULL. Punktas sukurtas (žr. Devices.jsx
--                  "Atsinešti" mygtuką prie kiekvieno prietaiso), dar
--                  niekas nepaimta.
--   2) Paimta    — picked_at IS NOT NULL, writeoff_id IS NULL. Fiziškai
--                  paimta iš nurodytos lokacijos (paprastas UPDATE, be
--                  jokio poveikio device_stock/device_writeoffs).
--   3) Nurašyta  — writeoff_id IS NOT NULL. Tik dabar sumažinamas
--                  device_stock IR sukuriamas device_writeoffs audito
--                  įrašas (žr. finalize_device_pickup() žemiau).
--
-- Papildo migrate_add_device_writeoffs.sql / migrate_fix_device_writeoffs_denormalize.sql:
--  1) prideda ketvirtą nurašymo priežastį 'garantija' (device_writeoffs
--     CHECK apribojimas + writeoff_device() validacija); 'garantija' (kaip
--     ir 'kita') gali turėti laisvo teksto pastabą, bet NEBŪTINĄ;
--  2) writeoff_device() dabar GRĄŽINA naujai sukurto įrašo id (buvo "returns
--     void") — reikalinga finalize_device_pickup(), kad žinotų, kurį
--     device_writeoffs įrašą susieti su konkrečiu device_pickups punktu.

alter table public.device_writeoffs
  drop constraint if exists device_writeoffs_reason_type_check;
alter table public.device_writeoffs
  add constraint device_writeoffs_reason_type_check
  check (reason_type in ('parduota', 'remontui', 'kita', 'garantija'));

create or replace function public.writeoff_device(
  p_device_id uuid,
  p_location text,
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

  select ds.quantity, d.name, d.ian
    into v_current_qty, v_device_name, v_device_ian
    from public.device_stock ds
    join public.devices d on d.id = ds.device_id
    where ds.device_id = p_device_id and ds.location = p_location
    for update of ds;

  if v_current_qty is null then
    raise exception 'Lokacija nerasta.';
  end if;
  if p_quantity > v_current_qty then
    raise exception 'Nurašomas kiekis (%) negali viršyti turimo likučio (%).', p_quantity, v_current_qty;
  end if;

  update public.device_stock
    set quantity = quantity - p_quantity
    where device_id = p_device_id and location = p_location;

  insert into public.device_writeoffs
    (device_id, device_name, device_ian, location, user_id, quantity, reason_type, price, rma, reason)
  values (
    p_device_id,
    v_device_name,
    v_device_ian,
    p_location,
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

grant execute on function public.writeoff_device(uuid, text, integer, text, numeric, text, text) to authenticated;

-- Atšaukus nurašymą, kuris kilo iš atsinešimų sąrašo punkto, tas punktas
-- turi grįžti į "Paimta (dar nenurašyta)" būseną — kitaip liktų klaidingai
-- rodomas kaip "Nurašyta", nors kiekis jau grąžintas atgal į device_stock.
create or replace function public.undo_device_writeoff(p_writeoff_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device_id uuid;
  v_location  text;
  v_quantity  integer;
  v_undone    timestamptz;
begin
  if not public.has_device_permission(auth.uid(), 'delete') then
    raise exception 'Neturite teisės atšaukti nurašymo.';
  end if;

  select device_id, location, quantity, undone_at
    into v_device_id, v_location, v_quantity, v_undone
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

  insert into public.device_stock (device_id, location, quantity)
  values (v_device_id, v_location, v_quantity)
  on conflict (device_id, location) do update
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
-- device_pickups — atsinešimų sąrašo punktai. "picked_at" (NULL = laukia,
-- užpildyta = fiziškai paimta) IR "writeoff_id" (NULL = dar nenurašyta,
-- užpildyta = nurašyta) — du NEPRIKLAUSOMI žingsniai, ta pati
-- "timestamptz/FK kaip būsena" logika, kaip likusioje schemoje.
-- ------------------------------------------------------------
create table if not exists public.device_pickups (
  id              uuid primary key default gen_random_uuid(),
  device_id       uuid not null references public.devices (id) on delete cascade,
  quantity        integer not null check (quantity > 0),
  note            text,
  user_id         uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  picked_at       timestamptz,
  picked_by       uuid references public.profiles (id) on delete set null,
  picked_location text,
  writeoff_id     uuid references public.device_writeoffs (id) on delete set null
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
-- jau paimtas (nesvarbu, nurašytas ar ne), jis nebelaikomas paprastu "to-do"
-- punktu.
create policy "Tik dar nepaimto punkto trynimas pagal 'edit' teisę"
  on public.device_pickups for delete
  to authenticated
  using (public.has_device_permission(auth.uid(), 'edit') and picked_at is null);

-- Pažymėti "paimta" (picked_at/picked_by/picked_location) — paprastas
-- UPDATE per RLS, NE SECURITY DEFINER funkcija, nes šis žingsnis
-- NETURI jokio šalutinio poveikio kitoms lentelėms (kiekis dar nekeičiamas).
-- "using" leidžia pradėti atnaujinimą tik dar nepaimtam punktui, kad
-- nebūtų perrašoma jau užfiksuota paėmimo informacija.
create policy "Punkto žymėjimas paimtu pagal 'edit' teisę"
  on public.device_pickups for update
  to authenticated
  using (public.has_device_permission(auth.uid(), 'edit') and picked_at is null)
  with check (public.has_device_permission(auth.uid(), 'edit'));

-- Nurašymas (kiekio atėmimas) — TIK per šią SECURITY DEFINER funkciją,
-- reikalauja 'delete' teisės (ta pati, kuri jau naudojama bet kokiam
-- nurašymui). Naudoja punkte jau užfiksuotą lokaciją/kiekį/pastabą — antrą
-- kartą jų rinktis nereikia, nes vartotojas juos jau nurodė "Paimta" žingsnyje.
create or replace function public.finalize_device_pickup(p_pickup_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device_id  uuid;
  v_quantity   integer;
  v_note       text;
  v_location   text;
  v_picked_at  timestamptz;
  v_writeoff_id uuid;
begin
  if not public.has_device_permission(auth.uid(), 'delete') then
    raise exception 'Neturite nurašymo teisės.';
  end if;

  select device_id, quantity, note, picked_location, picked_at, writeoff_id
    into v_device_id, v_quantity, v_note, v_location, v_picked_at, v_writeoff_id
    from public.device_pickups
    where id = p_pickup_id
    for update;

  if v_device_id is null then
    raise exception 'Sąrašo punktas nerastas.';
  end if;
  if v_picked_at is null then
    raise exception 'Punktas dar nepažymėtas kaip paimtas.';
  end if;
  if v_writeoff_id is not null then
    raise exception 'Šis punktas jau nurašytas.';
  end if;

  v_writeoff_id := public.writeoff_device(v_device_id, v_location, v_quantity, 'garantija', null, null, v_note);

  update public.device_pickups
    set writeoff_id = v_writeoff_id
    where id = p_pickup_id;
end;
$$;

grant execute on function public.finalize_device_pickup(uuid) to authenticated;

alter publication supabase_realtime add table public.device_pickups;
