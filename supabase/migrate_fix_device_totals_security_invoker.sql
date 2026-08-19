-- Paleisti Supabase Dashboard → SQL Editor
-- KRITINIS SAUGUMO PATAISYMAS — jei device_totals VIEW jau sukurtas per
-- migrate_add_devices.sql (BE "security_invoker = true"), jis vykdo
-- devices/device_stock RLS politikas VIEW SAVININKO (Supabase atveju
-- "postgres" rolės, kuri turi BYPASSRLS) teisėmis, NE užklausą siunčiančio
-- vartotojo. Praktiškai tai reiškia, kad BET KURIS prisijungęs vartotojas —
-- net neturintis JOKIOS device_permissions eilutės — galėjo per
-- `supabase.from('device_totals').select('*')` (arba per Stats.jsx
-- prietaisų statistikos skirtuką) matyti visų prietaisų pavadinimus, IAN,
-- gamintojus, bendrus kiekius ir lokacijų skaičių, VISIŠKAI apeidamas
-- modulio pagrindinį principą — "Peržiūra ČIA NĖRA VIEŠA".
--
-- Šis "alter view" pataiso jau egzistuojantį view'ą DB, kurioje
-- migrate_add_devices.sql jau buvo paleistas su senąja (pažeidžiama)
-- versija. Naujam projektui (schema.sql) parinktis jau įtraukta į patį
-- "create view" sakinį, tad šio pataisymo paleisti atskirai nereikia.

alter view public.device_totals set (security_invoker = true);
