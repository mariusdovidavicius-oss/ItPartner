-- Paleisti Supabase Dashboard → SQL Editor.
-- Taiso migrate_add_parts_permissions.sql: import_parts() anksčiau leido
-- vartotojui, turinčiam TIK 'import' teisę, per "clear_existing" parametrą
-- ištrinti visą parts lentelę — nors tas pats vartotojas per UI negalėjo
-- ištrinti nė vieno pavienio įrašo (reikalauja 'delete' teisės). Dabar
-- clear_existing papildomai reikalauja 'delete' teisės.

create or replace function public.import_parts(rows jsonb, clear_existing boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer;
begin
  if not public.has_permission(auth.uid(), 'import') then
    raise exception 'Neturite importo teisės.';
  end if;

  if clear_existing then
    if not public.has_permission(auth.uid(), 'delete') then
      raise exception 'Norint prieš importą išvalyti esamus duomenis, reikia trynimo teisės.';
    end if;
    delete from public.parts;
  end if;

  insert into public.parts (location, main_model, part_code, name, quantity, online_store, compatible_models)
  select
    (r->>'location')::integer,
    nullif(r->>'main_model', ''),
    r->>'part_code',
    nullif(r->>'name', ''),
    coalesce((r->>'quantity')::integer, 0),
    coalesce((r->>'online_store')::boolean, false),
    nullif(r->>'compatible_models', '')
  from jsonb_array_elements(rows) as r;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;
