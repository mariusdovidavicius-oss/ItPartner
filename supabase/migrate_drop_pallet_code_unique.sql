-- Paleisti Supabase Dashboard → SQL Editor
-- Paletžų numeravimas dabar cikliškai atsistato į 1 po kiekvienos siuntos
-- uždarymo (žr. migrate_reset_pallet_numbering.sql), todėl "code" (pvz. "PAL-1")
-- gali pasikartoti tarp skirtingų siuntos ciklų. Unikalumą užtikrina "id" (uuid),
-- todėl "code" stulpelio unique apribojimas pašalinamas.

alter table public.pallets drop constraint if exists pallets_code_key;
