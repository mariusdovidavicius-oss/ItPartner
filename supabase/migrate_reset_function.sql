-- Paleisti Supabase Dashboard → SQL Editor
-- Sukuria reset_test_data() funkciją testavimo duomenų išvalymui.
-- Reikalauja prisijungusio admin vartotojo (žr. migrate_add_parts_permissions.sql
-- is_admin() funkciją) — žr. taip pat migrate_admin_reset_require_admin.sql,
-- kuri šią funkciją vėliau apribojo tik adminams.

create or replace function public.reset_test_data()
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  truncate table
    public.item_history,
    public.items,
    public.pallets,
    public.shipments
  cascade;

  alter sequence public.pallets_number_seq restart with 1;

  return json_build_object('ok', true);
end;
$$;

-- Pašalinti numatytąsias teises, tada suteikti tik šiai funkcijai
revoke all on function public.reset_test_data() from public;
grant execute on function public.reset_test_data() to anon, authenticated;
