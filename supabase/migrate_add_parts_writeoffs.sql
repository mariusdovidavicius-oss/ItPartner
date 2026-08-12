-- Paleisti Supabase Dashboard → SQL Editor
-- Priedo nurašymas — sumažina parts.quantity nurodytu kiekiu ir palieka
-- audito įrašą (kas/kada/kiek/kodėl). Reikalauja "delete" teisės (ta pati,
-- kuri jau naudojama pavienio priedo trynimui), kad nereikėtų plėsti
-- teisių sąrašo. Kiekio atnaujinimas ir audito įrašas atliekami per vieną
-- SECURITY DEFINER RPC funkciją, kad nereikėtų atskirai duoti "edit" teisės
-- vien dėl quantity atnaujinimo.
--
-- Priežastis (reason_type) — vienas iš trijų: "parduota" (su kaina),
-- "remontui" (su RMA numeriu) arba "kita" (su laisvu tekstu). UI pusėje tai
-- rodoma kaip dropdown su papildomu lauku, priklausomu nuo pasirinkimo.

create table if not exists public.parts_writeoffs (
  id          uuid primary key default gen_random_uuid(),
  part_id     uuid not null references public.parts (id) on delete cascade,
  user_id     uuid references public.profiles (id) on delete set null,
  quantity    integer not null check (quantity > 0),
  reason_type text not null check (reason_type in ('parduota', 'remontui', 'kita')),
  price       numeric(10, 2),
  rma         text,
  reason      text,
  created_at  timestamptz not null default now()
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

alter publication supabase_realtime add table public.parts_writeoffs;
