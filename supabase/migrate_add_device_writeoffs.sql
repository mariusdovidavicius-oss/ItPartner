-- Paleisti Supabase Dashboard → SQL Editor
-- Papildo migrate_add_devices.sql / migrate_devices_notes.sql — prietaisų
-- nurašymo funkcija, ta pati logika kaip parts_writeoffs (žr.
-- migrate_add_parts_writeoffs.sql, migrate_writeoff_undo.sql,
-- migrate_parts_writeoffs_reason_type.sql), pritaikyta prietaisams.
--
-- Skirtingai nuo parts (kur kiekis yra vienas part.quantity laukas),
-- prietaiso kiekis yra PER LOKACIJĄ (device_stock), todėl nurašymas visada
-- nurodo konkrečią lokaciją — mažina device_stock.quantity tai lokacijai,
-- ne bendrą prietaiso kiekį. "location" audito lentelėje saugoma kaip
-- LAISVAS TEKSTAS (kopija nurašymo metu), o ne FK į device_stock — jei
-- vartotojas vėliau ištrina tą lokacijos likutį (žr. Devices.jsx
-- handleDeleteStock), audito įrašas turi išlikti nepaliestas.
--
-- "device_name"/"device_ian" TAIP PAT denormalizuoti (kopija nurašymo
-- metu) dėl DVIEJŲ priežasčių:
--  1) device_id nuoroda dabar "on delete set null" (NE cascade) — ištrynus
--     patį prietaisą, nurašymų audito istorija turi IŠLIKTI (kaip ir
--     parts_writeoffs niekada netrina savo įrašų), o be denormalizuotų
--     laukų prietaiso pavadinimas/IAN dingtų kartu su devices eilute.
--  2) devices SELECT reikalauja atskiros 'view' teisės (RLS) — jei
--     nurašymų sąrašas jungtųsi su devices per JOIN, vartotojui, turinčiam
--     TIK 'delete' be 'view', įrašai tiesiog dingtų iš sąrašo. Denormalizavus
--     laukus, /prietaisai/nurasymai puslapiui pakanka VIEN 'delete' teisės.
create table if not exists public.device_writeoffs (
  id          uuid primary key default gen_random_uuid(),
  device_id   uuid references public.devices (id) on delete set null,
  device_name text,
  device_ian  text not null,
  location    text not null,
  user_id     uuid references public.profiles (id) on delete set null,
  quantity    integer not null check (quantity > 0),
  reason_type text not null check (reason_type in ('parduota', 'remontui', 'kita')),
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

create or replace function public.writeoff_device(
  p_device_id uuid,
  p_location text,
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
  v_current_qty  integer;
  v_device_name  text;
  v_device_ian   text;
begin
  if not public.has_device_permission(auth.uid(), 'delete') then
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
    case when p_reason_type = 'kita' then nullif(trim(p_reason), '') else null end
  );
end;
$$;

grant execute on function public.writeoff_device(uuid, text, integer, text, numeric, text, text) to authenticated;

-- Atšaukimas — grąžina kiekį atgal į device_stock. Jei lokacijos likučio
-- eilutė tarp nurašymo ir atšaukimo buvo ištrinta (žr. handleDeleteStock),
-- ji sukuriama iš naujo su grąžintu kiekiu (upsert), o ne meta klaidą — kad
-- atšaukimas visada pavyktų, nepriklausomai nuo to, kas nutiko su likučiu
-- tarpiniu metu. Jei pats PRIETAISAS buvo ištrintas (device_id — "on delete
-- set null" — jau NULL), grąžinti kiekį nebėra kur, tad aiškiai pranešame
-- apie tai vietoj to, kad tyliai nieko nepadarytume arba klaidingai
-- pažymėtume kaip atšauktą.
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
end;
$$;

grant execute on function public.undo_device_writeoff(uuid) to authenticated;

alter publication supabase_realtime add table public.device_writeoffs;
