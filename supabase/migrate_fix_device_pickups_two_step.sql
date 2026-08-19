-- Paleisti Supabase Dashboard → SQL Editor
-- Pataiso JAU PALEISTĄ migrate_add_device_pickups.sql versiją: "Paimta"
-- žymėjimas ir kiekio nurašymas buvo sujungti į vieną veiksmą
-- (pick_up_device()) — dabar tai DU ATSKIRI ŽINGSNIAI:
--   1) Paimta   — picked_at užpildomas (paprastas UPDATE), device_stock
--                 NEKEIČIAMAS.
--   2) Nurašyta — writeoff_id užpildomas (finalize_device_pickup() RPC),
--                 TIK DABAR sumažinamas device_stock ir sukuriamas
--                 device_writeoffs įrašas.

-- 1) writeoff_id — NULL = dar nenurašyta, užpildyta = nurašyta (susietas
-- device_writeoffs įrašas).
alter table public.device_pickups
  add column if not exists writeoff_id uuid references public.device_writeoffs (id) on delete set null;

-- 2) writeoff_device() dabar GRĄŽINA sukurto įrašo id (buvo "returns
-- void") — reikalinga finalize_device_pickup(), kad žinotų, kurį
-- device_writeoffs įrašą susieti. PostgreSQL neleidžia keisti grąžinamo
-- tipo per "create or replace" — pirma DROP.
drop function if exists public.writeoff_device(uuid, text, integer, text, numeric, text, text);

create function public.writeoff_device(
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

-- 3) undo_device_writeoff() — papildomai išvalo device_pickups.writeoff_id,
-- jei atšaukiamas nurašymas kilo iš atsinešimų sąrašo punkto (kitaip
-- punktas liktų klaidingai rodomas kaip "Nurašyta", nors kiekis jau
-- grąžintas atgal).
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

-- 4) Pažymėti "paimta" — nauja SECURITY DEFINER funkcija (NE tiesioginė
-- UPDATE RLS politika), kad "picked_by"/"picked_at" būtų nustatomi
-- SERVERIO pusėje (auth.uid()/now()), o ne kliento siunčiamais laukais —
-- kitaip klientas teoriškai galėtų nurodyti bet kieno ID kaip paėmėją.
-- Ta pati logika, kaip ir kitur šioje schemoje (user_id/undone_by ir pan.
-- visada auth.uid(), niekada parametras).
create or replace function public.mark_device_picked(p_pickup_id uuid, p_location text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_picked_at timestamptz;
begin
  if not public.has_device_permission(auth.uid(), 'edit') then
    raise exception 'Neturite teisės žymėti kaip paimta.';
  end if;

  select picked_at into v_picked_at from public.device_pickups where id = p_pickup_id for update;

  if not found then
    raise exception 'Sąrašo punktas nerastas.';
  end if;
  if v_picked_at is not null then
    raise exception 'Šis punktas jau pažymėtas kaip paimtas.';
  end if;

  update public.device_pickups
    set picked_at = now(), picked_by = auth.uid(), picked_location = p_location
    where id = p_pickup_id;
end;
$$;

grant execute on function public.mark_device_picked(uuid, text) to authenticated;

-- 5) Senoji pick_up_device() (žymėjo paimta IR nurašydavo vienu metu)
-- nebenaudojama — pakeista dviem atskirais žingsniais.
drop function if exists public.pick_up_device(uuid, text);

-- 6) Nauja finalize_device_pickup() — kiekio nurašymas, ANTRAS (atskiras)
-- žingsnis po "paimta". Naudoja punkte jau užfiksuotą lokaciją/kiekį/
-- pastabą — antrą kartą jų rinktis nereikia.
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
