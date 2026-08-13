-- Paleisti Supabase Dashboard → SQL Editor
-- Nurašymo atšaukimas — leidžia grąžinti klaidingai nurašytą kiekį atgal
-- į parts.quantity. Įrašas NETRINAMAS (audito pėdsakas turi likti) — tik
-- pažymimas undone_at/undone_by. Atšaukti galima tik kartą (patikrinama
-- funkcijoje); reikalauja tos pačios "delete" teisės, kaip ir pats
-- nurašymas. Tiesioginės update politikos parts_writeoffs lentelei nėra —
-- atšaukti galima tik per šią SECURITY DEFINER funkciją (ta pati logika,
-- kaip writeoff_part neturi tiesioginės insert politikos).

alter table public.parts_writeoffs
  add column if not exists undone_at timestamptz;
alter table public.parts_writeoffs
  add column if not exists undone_by uuid references public.profiles (id) on delete set null;

create or replace function public.undo_writeoff(p_writeoff_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_part_id  uuid;
  v_quantity integer;
  v_undone   timestamptz;
begin
  if not public.has_permission(auth.uid(), 'delete') then
    raise exception 'Neturite teisės atšaukti nurašymo.';
  end if;

  select part_id, quantity, undone_at
    into v_part_id, v_quantity, v_undone
    from public.parts_writeoffs
    where id = p_writeoff_id
    for update;

  if v_part_id is null then
    raise exception 'Nurašymas nerastas.';
  end if;
  if v_undone is not null then
    raise exception 'Šis nurašymas jau atšauktas.';
  end if;

  update public.parts set quantity = quantity + v_quantity where id = v_part_id;

  update public.parts_writeoffs
    set undone_at = now(), undone_by = auth.uid()
    where id = p_writeoff_id;
end;
$$;

grant execute on function public.undo_writeoff(uuid) to authenticated;
