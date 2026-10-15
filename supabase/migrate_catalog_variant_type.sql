-- Paleisti Supabase Dashboard → SQL Editor
-- PALEIDIMO TVARKA: po migrate_add_catalog_variants.sql.
--
-- Gamintojas/tipas — VARIANTO savybė: tas pats IAN gali žymėti ir
-- prietaisą, ir jo akumuliatorių/kroviklį (pvz. 354828: Prietaisas ir Bat),
-- kurie keliauja į skirtingas paletes. Registruojant paletės paskirtis
-- skaičiuojama iš pasirinkto varianto; catalog.manufacturer/item_type lieka
-- numatytoji reikšmė (variantui be savo gamintojo/tipo ir senam kodui).
-- ------------------------------------------------------------

alter table public.catalog_variants
  add column if not exists manufacturer text,
  add column if not exists item_type    text;

-- Esami variantai paveldi IAN gamintoją/tipą.
update public.catalog_variants v
  set manufacturer = c.manufacturer,
      item_type    = c.item_type
  from public.catalog c
  where c.ian = v.ian
    and v.manufacturer is null
    and v.item_type is null;
