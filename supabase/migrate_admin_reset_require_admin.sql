-- Paleisti Supabase Dashboard → SQL Editor.
-- REIKALAUJA, kad prieš tai jau būtų paleista migrate_add_parts_permissions.sql
-- (naudoja jos is_admin() funkciją).
--
-- Apriboja reset_test_data() tik prisijungusiems administratoriams. Anksčiau
-- (migrate_reset_function.sql ir vėlesnės jos redakcijos) ši funkcija buvo
-- leidžiama BET KAM su viešu "anon" raktu — nepriklausomai nuo to, ar
-- /admin-reset puslapis buvo užrakintas React pusėje (React apsauga
-- lengvai apeinama kreipiantis tiesiai į Supabase REST API).

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
  truncate table public.pallet_ready_counters;

  return json_build_object('ok', true);
end;
$$;

revoke all on function public.reset_test_data() from public, anon;
grant execute on function public.reset_test_data() to authenticated;
