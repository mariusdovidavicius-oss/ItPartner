-- Paleisti Supabase Dashboard → SQL Editor
-- Papildo jau paleistą migrate_add_parts_writeoffs.sql (senoji versija su
-- laisvo teksto "reason" lauku) — prideda struktūrizuotą priežastį:
-- reason_type ("parduota" / "remontui" / "kita") + price/rma laukus.

alter table public.parts_writeoffs
  add column if not exists reason_type text,
  add column if not exists price numeric(10, 2),
  add column if not exists rma text;

-- Jau esami įrašai (jei tokių yra) neturi reason_type — pažymime juos kaip
-- "kita" (senasis laisvas tekstas lieka "reason" stulpelyje), kad būtų
-- galima pritaikyti NOT NULL apribojimą.
update public.parts_writeoffs set reason_type = 'kita' where reason_type is null;

alter table public.parts_writeoffs
  alter column reason_type set not null;

alter table public.parts_writeoffs
  drop constraint if exists parts_writeoffs_reason_type_check;
alter table public.parts_writeoffs
  add constraint parts_writeoffs_reason_type_check check (reason_type in ('parduota', 'remontui', 'kita'));

-- Sena writeoff_part(uuid, integer, text) versija pakeičiama nauja — su
-- kitokia parametrų sąrašo forma, tad senąją reikia eksplicitiškai
-- pašalinti (kitaip liktų kaip atskiras, nebenaudojamas overload'as).
drop function if exists public.writeoff_part(uuid, integer, text);

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
