-- Paleisti Supabase Dashboard → SQL Editor
-- Prideda quantity stulpeli prie items lentelės esamai duomenų bazei

alter table public.items
  add column if not exists quantity integer not null default 1;
