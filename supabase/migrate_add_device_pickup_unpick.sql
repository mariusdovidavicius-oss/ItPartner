-- Paleisti Supabase Dashboard → SQL Editor
-- "Atgal" veiksmas — leidžia grąžinti klaidingai (ar ne tą lokaciją)
-- "paimtą" atsinešimo punktą atgal į "Laukia" būseną. Galima TIK jei
-- punktas dar NENURAŠYTAS (writeoff_id is null) — jei jau nurašytas,
-- pirma reikia atšaukti patį nurašymą per /prietaisai/nurasymai
-- (undo_device_writeoff), kuris jau automatiškai išvalo writeoff_id (žr.
-- migrate_fix_device_pickups_two_step.sql) ir tada punktą būtų galima
-- grąžinti šia funkcija.

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
    set picked_at = null, picked_by = null, picked_location = null
    where id = p_pickup_id;
end;
$$;

grant execute on function public.unpick_device_pickup(uuid) to authenticated;
