-- Paleisti Supabase Dashboard → SQL Editor
-- Priedų (parts) sąrašo PERŽIŪRA tampa vieša — /priedai puslapį gali matyti
-- bet kas, be prisijungimo. Redagavimas/trynimas/importas ir toliau
-- reikalauja prisijungimo + atitinkamos teisės (migrate_add_parts_permissions.sql,
-- migrate_fix_import_parts_delete_permission.sql) — ši migracija keičia
-- TIK select taisyklę, insert/update/delete politikos nekeičiamos.

drop policy if exists "Peržiūra pagal 'view' teisę" on public.parts;

create policy "Vieša priedų peržiūra"
  on public.parts for select
  to anon, authenticated
  using (true);
