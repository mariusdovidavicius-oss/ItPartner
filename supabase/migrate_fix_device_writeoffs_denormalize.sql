-- Paleisti Supabase Dashboard → SQL Editor
-- Pataiso migrate_add_device_writeoffs.sql versijoje buvusią spragą:
--
--  1) device_id buvo "not null ... on delete CASCADE" — ištrynus PATĮ
--     PRIETAISĄ (/prietaisai → "Ištrinti prietaisą"), visa jo nurašymų
--     audito istorija (parduota/remontui/kita, kas/kada/kiek) buvo
--     NEGRĮŽTAMAI sunaikinama kartu — priešingai likusios schemos
--     filosofijai, kur audito įrašai niekada netrinami (žr. parts_writeoffs
--     undone_at soft-delete).
--  2) /prietaisai/nurasymai puslapis jungėsi su devices per JOIN vardui/IAN
--     gauti — devices SELECT RLS reikalauja ATSKIROS 'view' teisės, tad
--     vartotojui, turinčiam TIK 'delete' (be 'view'), visi nurašymų
--     įrašai tiesiog dingdavo iš sąrašo.
--
-- Sprendimas: device_name/device_ian denormalizuojami (kopija nurašymo
-- metu, ta pati logika kaip jau buvo "location"), device_id tampa
-- NULLABLE su "on delete SET NULL".

alter table public.device_writeoffs
  add column if not exists device_name text,
  add column if not exists device_ian text;

update public.device_writeoffs w
set device_name = d.name,
    device_ian = d.ian
from public.devices d
where d.id = w.device_id
  and w.device_ian is null;

-- Apsauginis fallback — jei kuriam nors įrašui devices eilutės jau nebūtų
-- (teoriškai negalėjo atsitikti su senuoju "on delete cascade", bet apsaugo
-- nuo NOT NULL pažeidimo, jei ši migracija paleidžiama pakartotinai ar
-- neįprastu duomenų stovio atveju).
update public.device_writeoffs
set device_ian = coalesce(device_ian, '—')
where device_ian is null;

alter table public.device_writeoffs
  alter column device_ian set not null;

alter table public.device_writeoffs
  drop constraint if exists device_writeoffs_device_id_fkey;

alter table public.device_writeoffs
  alter column device_id drop not null;

alter table public.device_writeoffs
  add constraint device_writeoffs_device_id_fkey
  foreign key (device_id) references public.devices (id) on delete set null;

comment on table public.device_writeoffs is 'Prietaisų nurašymų (parduota/remontui/kita) audito istorija, po lokaciją. device_name/device_ian denormalizuoti — išgyvena prietaiso ištrynimą.';

-- writeoff_device — dabar papildomai nuskaito devices.name/ian nurašymo
-- metu ir įrašo juos į device_writeoffs kartu su location.
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

-- undo_device_writeoff — "nerastas" tikrinamas per v_location (visada NOT
-- NULL), NE v_device_id (kuris dabar gali būti teisėtai NULL, jei prietaisas
-- tarpu ištrintas). Jei prietaisas ištrintas, kiekio grąžinti nebėra kur —
-- apie tai aiškiai pranešama, o ne tyliai nieko nedaroma ar klaidingai
-- pažymima kaip atšaukta.
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
