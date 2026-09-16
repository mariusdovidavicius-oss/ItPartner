-- Paleisti Supabase Dashboard → SQL Editor.
--
-- parts.location buvo integer, todėl negalėjo saugoti realaus sandėlio
-- žymėjimo formato "42 (-7-)" (42 = dėžės numeris, -7- = mažos dėžutės
-- numeris dėžės viduje) — importas tokias eilutes tyliai atmesdavo
-- (žr. PartsImport.jsx). Keičiama į text, kaip devices.location.
alter table public.parts
  alter column location type text using location::text;

-- import_parts() RPC (migrate_fix_import_parts_delete_permission.sql) vertė
-- location į ::integer prieš insert — su text stulpeliu tai keltų klaidą
-- (arba tiesiog nebeleistų "42 (-7-)" formato), todėl kastas pašalintas.
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
    r->>'location',
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

revoke all on function public.import_parts(jsonb, boolean) from public, anon;
grant execute on function public.import_parts(jsonb, boolean) to authenticated;
