-- Paleisti Supabase Dashboard → SQL Editor
-- Prietaisų (devices) sąrašo PERŽIŪRA tampa vieša — /prietaisai puslapį
-- gali matyti bet kas, be prisijungimo — TA PATI logika, kaip jau veikia
-- priedams (žr. migrate_parts_public_view.sql). Tai keičia originalų
-- migrate_add_devices.sql sprendimą ("Peržiūra ČIA NĖRA VIEŠA").
--
-- Redagavimas/trynimas/nurašymas/importas IR TOLIAU reikalauja prisijungimo
-- + atitinkamos teisės (edit/delete/import) — ši migracija keičia TIK
-- devices/device_stock select politikas, insert/update/delete nekeičiamos.
-- device_writeoffs (nurašymų audito istorija) ir device_permissions IR
-- TOLIAU lieka prieinami tik prisijungusiems — ši migracija jų neliečia.
--
-- device_totals VIEW (su security_invoker=true, žr.
-- migrate_fix_device_totals_security_invoker.sql) automatiškai paveldi šį
-- pakeitimą — atskirai jo keisti nereikia.

drop policy if exists "Prietaisų peržiūra pagal 'view' teisę" on public.devices;

create policy "Vieša prietaisų peržiūra"
  on public.devices for select
  to anon, authenticated
  using (true);

drop policy if exists "Likučių peržiūra pagal 'view' teisę" on public.device_stock;

create policy "Vieša likučių peržiūra"
  on public.device_stock for select
  to anon, authenticated
  using (true);
