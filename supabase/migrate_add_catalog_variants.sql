-- Paleisti Supabase Dashboard → SQL Editor
-- PALEIDIMO TVARKA: po migrate_add_catalog_permission.sql.
--
-- Katalogo VARIANTAI — vienas IAN gali žymėti kelis skirtingus daiktus
-- (pvz. 501778: robotas vejapjovė, jo įkrovimo stotis, maitinimo blokas…).
-- catalog lieka viena eilutė vienam IAN (gamintojas/tipas → paletės
-- paskirtis), o catalog_variants saugo VISUS to IAN pavadinimus.
-- Registruojant IAN su ≥2 variantais vartotojas pasirenka konkretų daiktą
-- (ScanEntry.jsx), o paletėje skirtingi variantai — atskiros eilutės.
-- ------------------------------------------------------------

create table if not exists public.catalog_variants (
  id         uuid primary key default gen_random_uuid(),
  ian        text not null references public.catalog (ian) on delete cascade on update cascade,
  name       text not null,
  raw_text   text,
  created_at timestamptz not null default now(),
  constraint catalog_variants_ian_name_unique unique (ian, name)
);

comment on table public.catalog_variants is 'Visi to paties IAN pavadinimai (daiktai). Gamintojas/tipas — catalog lentelėje.';

create index if not exists catalog_variants_ian_idx on public.catalog_variants (ian);

alter table public.catalog_variants enable row level security;

drop policy if exists "Vieša katalogo variantų peržiūra" on public.catalog_variants;
create policy "Vieša katalogo variantų peržiūra"
  on public.catalog_variants for select
  to anon, authenticated
  using (true);

drop policy if exists "Katalogo variantų kūrimas pagal 'scan' teisę" on public.catalog_variants;
create policy "Katalogo variantų kūrimas pagal 'scan' teisę"
  on public.catalog_variants for insert
  to authenticated
  with check (public.has_pallet_permission(auth.uid(), 'scan'));

drop policy if exists "Katalogo variantų atnaujinimas pagal 'scan' teisę" on public.catalog_variants;
create policy "Katalogo variantų atnaujinimas pagal 'scan' teisę"
  on public.catalog_variants for update
  to authenticated
  using (public.has_pallet_permission(auth.uid(), 'scan'))
  with check (public.has_pallet_permission(auth.uid(), 'scan'));

drop policy if exists "Katalogo variantų trynimas pagal 'scan' teisę" on public.catalog_variants;
create policy "Katalogo variantų trynimas pagal 'scan' teisę"
  on public.catalog_variants for delete
  to authenticated
  using (public.has_pallet_permission(auth.uid(), 'scan'));

-- Esamas katalogas: kiekvienas IAN gauna vieną variantą — dabartinį pavadinimą.
-- Kiti to paties IAN pavadinimai atsiras pakartotinai importavus katalogo failą.
insert into public.catalog_variants (ian, name, raw_text)
select ian, trim(name), raw_text
from public.catalog
where nullif(trim(name), '') is not null
on conflict (ian, name) do nothing;
