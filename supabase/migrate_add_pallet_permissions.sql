-- ============================================================
-- Paletžų/siuntų modulio prisijungimas ir teisės.
-- Tapatybė (profiles/auth.users, prisijungimo ID/slaptažodis) lieka BENDRA
-- su priedų moduliu — Supabase Auth naršyklės lange palaiko tik vieną
-- aktyvią sesiją, tad atskiri "paletžų vartotojai" su savo prisijungimu
-- reikštų, kad tas pats žmogus turėtų dvi paskyras ir turėtų atsijungti/
-- prisijungti iš naujo norėdamas pereiti tarp priedų ir paletžų. Vietoj to
-- ATSKIRIAMOS TIK TEISĖS: nauja pallet_permissions lentelė, visiškai
-- nepriklausoma nuo user_permissions (priedų view/edit/delete/import).
-- Vartotojas su priedų "edit" teise NEGAUNA jokių paletžų teisių, ir
-- atvirkščiai — adminas jas priskiria atskirai.
--
-- Peržiūra (pallets/items/shipments SELECT) LIEKA VIEŠA visiems (anon),
-- kaip ir anksčiau — keičiasi tik INSERT/UPDATE/DELETE, kurie dabar
-- reikalauja prisijungimo + atitinkamos teisės.
--
-- Teisės:
--   'scan' — ScanEntry ir PalletDetail: prietaisų registravimas/redagavimas/
--            trynimas, paletės uždarymas/trynimas/pastabos/statusas.
--   'ship' — Pallets.jsx: uždarytų palečių žymėjimas "paruošta išvežimui",
--            siuntos formavimas ("paruošta" -> "išvežta").
-- Naudoja tą patį is_admin (žr. migrate_add_parts_permissions.sql) kaip
-- bendrą super-adminą, apeinantį visas teises abiejuose moduliuose —
-- jis jau valdo admin-reset, kuris paveikia ir paletžų duomenis.
-- ============================================================

create table if not exists public.pallet_permissions (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  permission text not null check (permission in ('scan', 'ship')),
  granted_at timestamptz not null default now(),
  primary key (user_id, permission)
);

comment on table public.pallet_permissions is 'Kiekvienam vartotojui suteiktos paletžų/siuntų modulio teisės — nepriklausomos nuo user_permissions (priedų).';

alter table public.pallet_permissions enable row level security;

create policy "Vartotojas mato savo paletžų teises, adminas visas"
  on public.pallet_permissions for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin(auth.uid()));

create policy "Adminas tvarko paletžų teises"
  on public.pallet_permissions for all
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create or replace function public.has_pallet_permission(uid uuid, perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin(uid) or exists (
    select 1 from public.pallet_permissions where user_id = uid and permission = perm
  );
$$;

grant execute on function public.has_pallet_permission(uuid, text) to authenticated, anon;

-- ------------------------------------------------------------
-- pallets: SELECT lieka vieša; INSERT/DELETE reikalauja 'scan' (paletę
-- automatiškai sukuria/tuščią ištrina tik skenavimo eiga); UPDATE leidžiama
-- turintiems 'scan' ARBA 'ship' (abi rolės teisėtai keičia pallets eilutes —
-- 'scan' uždaro/redaguoja pastabą, 'ship' žymi ready/priskiria shipment_id).
-- ------------------------------------------------------------
drop policy if exists "Anon and authenticated full access - pallets" on public.pallets;

create policy "Vieša palečių peržiūra"
  on public.pallets for select
  to anon, authenticated
  using (true);

create policy "Palečių kūrimas pagal 'scan' teisę"
  on public.pallets for insert
  to authenticated
  with check (public.has_pallet_permission(auth.uid(), 'scan'));

create policy "Palečių atnaujinimas pagal 'scan' arba 'ship' teisę"
  on public.pallets for update
  to authenticated
  using (public.has_pallet_permission(auth.uid(), 'scan') or public.has_pallet_permission(auth.uid(), 'ship'))
  with check (public.has_pallet_permission(auth.uid(), 'scan') or public.has_pallet_permission(auth.uid(), 'ship'));

create policy "Palečių trynimas pagal 'scan' teisę"
  on public.pallets for delete
  to authenticated
  using (public.has_pallet_permission(auth.uid(), 'scan'));

-- ------------------------------------------------------------
-- items: SELECT lieka vieša; INSERT/UPDATE/DELETE — tik 'scan' (prietaisai
-- valdomi vien per ScanEntry/PalletDetail, "ship" rolė items nesuka).
-- ------------------------------------------------------------
drop policy if exists "Anon and authenticated full access - items" on public.items;

create policy "Vieša prietaisų peržiūra"
  on public.items for select
  to anon, authenticated
  using (true);

create policy "Prietaisų kūrimas pagal 'scan' teisę"
  on public.items for insert
  to authenticated
  with check (public.has_pallet_permission(auth.uid(), 'scan'));

create policy "Prietaisų atnaujinimas pagal 'scan' teisę"
  on public.items for update
  to authenticated
  using (public.has_pallet_permission(auth.uid(), 'scan'))
  with check (public.has_pallet_permission(auth.uid(), 'scan'));

create policy "Prietaisų trynimas pagal 'scan' teisę"
  on public.items for delete
  to authenticated
  using (public.has_pallet_permission(auth.uid(), 'scan'));

-- ------------------------------------------------------------
-- shipments: SELECT lieka vieša; INSERT/UPDATE — tik 'ship' (siuntos
-- formuojamos/pažymimos išvežtos tik Pallets.jsx puslapyje).
-- ------------------------------------------------------------
drop policy if exists "Anon and authenticated full access - shipments" on public.shipments;

create policy "Vieša siuntų peržiūra"
  on public.shipments for select
  to anon, authenticated
  using (true);

create policy "Siuntų kūrimas pagal 'ship' teisę"
  on public.shipments for insert
  to authenticated
  with check (public.has_pallet_permission(auth.uid(), 'ship'));

create policy "Siuntų atnaujinimas pagal 'ship' teisę"
  on public.shipments for update
  to authenticated
  using (public.has_pallet_permission(auth.uid(), 'ship'))
  with check (public.has_pallet_permission(auth.uid(), 'ship'));
