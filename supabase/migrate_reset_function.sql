-- Paleisti Supabase Dashboard → SQL Editor
-- Sukuria reset_test_data() funkciją testavimo duomenų išvalymui.
-- Tik ši funkcija leidžiama anon raktui — jokių platesnių teisių.

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
