-- Paleisti Supabase Dashboard → SQL Editor
-- Prideda pastabos (notes) stulpelį prie jau egzistuojančios parts lentelės.

alter table public.parts
  add column if not exists notes text;
