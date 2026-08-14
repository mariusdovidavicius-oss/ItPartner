-- ============================================================
-- catalog: SELECT lieka vieša (reikalinga skenavimo/paieškos peržiūrai);
-- INSERT/UPDATE — 'scan' teisė. Ta pati teisė, kuri jau naudojama
-- ScanEntry "Naujas įrankis" sraute (pavienio įrašo upsert) — dabar
-- apsaugo ir /katalogas masinį importą (CatalogImport.jsx), kuris anksčiau
-- buvo pasiekiamas tik tiesioginiu adresu, be jokios teisių patikros nei
-- puslapyje, nei DB pusėje.
--
-- Atskiras failas nuo migrate_add_pallet_permissions.sql, nes ji jau
-- paleista — šis priklauso nuo joje sukurtos has_pallet_permission()
-- funkcijos, todėl paleisti PO jos.
-- ============================================================

drop policy if exists "Anon and authenticated full access - catalog" on public.catalog;

create policy "Vieša katalogo peržiūra"
  on public.catalog for select
  to anon, authenticated
  using (true);

create policy "Katalogo kūrimas pagal 'scan' teisę"
  on public.catalog for insert
  to authenticated
  with check (public.has_pallet_permission(auth.uid(), 'scan'));

create policy "Katalogo atnaujinimas pagal 'scan' teisę"
  on public.catalog for update
  to authenticated
  using (public.has_pallet_permission(auth.uid(), 'scan'))
  with check (public.has_pallet_permission(auth.uid(), 'scan'));
