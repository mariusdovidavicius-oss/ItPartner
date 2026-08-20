-- Paleisti Supabase Dashboard → SQL Editor.
--
-- Taiso migrate_admin_reset_require_admin.sql paliktą klaidą:
-- ta migracija (2026-08-11) admin-patikrinimą pridėjo teisingai, bet jos
-- reset_test_data() vis dar turėjo "truncate table public.pallet_ready_counters"
-- eilutę — o ta lentelė JAU BUVO PAŠALINTA anksčiau, per
-- migrate_simple_close_numbering.sql (2026-08-07). PL/pgSQL funkcijos
-- CREATE OR REPLACE metu Postgres netikrina, ar viduje minimos lentelės
-- egzistuoja (tik iškvietimo metu) — todėl migracija pritaikoma be klaidos,
-- bet PATS /admin-reset mygtukas realiai meta klaidą
-- "relation pallet_ready_counters does not exist" kiekvieną kartą paspaudus.
--
-- Jei jūsų DB jau neturi pallet_ready_counters lentelės (t.y. jau paleidote
-- migrate_simple_close_numbering.sql), paleiskite šią migraciją, kad
-- /admin-reset vėl veiktų. Jei abejojate, ar lentelė vis dar egzistuoja,
-- galite tiesiog paleisti šią migraciją — "truncate table public.pallet_number_counters"
-- veiks nepriklausomai nuo to.

create or replace function public.reset_test_data()
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Tik administratorius gali išvalyti testavimo duomenis.';
  end if;

  truncate table
    public.item_history,
    public.items,
    public.pallets,
    public.shipments
  cascade;

  truncate table public.pallet_number_counters;

  return json_build_object('ok', true);
end;
$$;

revoke all on function public.reset_test_data() from public, anon;
grant execute on function public.reset_test_data() to authenticated;
