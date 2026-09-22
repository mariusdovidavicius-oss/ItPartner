-- Paleisti Supabase Dashboard → SQL Editor
-- Priedo kaina — nauja, nebūtina savybė kiekvienam priedui (parts), atskira
-- nuo parts_writeoffs.price (kuri yra VIENO KONKREČIO nurašymo "parduota už"
-- suma, įvedama kaskart nurašant, žr. migrate_add_parts_writeoffs.sql). Ši
-- kaina — orientacinė/etaloninė priedo kaina, saugoma pačiame priede,
-- rodoma TIK išskleidus priedo eilutę /priedai puslapyje (ne pagrindinėje
-- lentelėje), redaguojama ten pat (kaip ir "Pastaba").
--
-- NULL = kaina nenurodyta (dauguma jau importuotų priedų). numeric(10,2) —
-- ta pati preciziją, kaip parts_writeoffs.price.

alter table public.parts
  add column if not exists price numeric(10, 2);

alter table public.parts
  drop constraint if exists parts_price_check;
alter table public.parts
  add constraint parts_price_check check (price is null or price >= 0);

comment on column public.parts.price is 'Orientacinė priedo kaina (€) — rodoma/redaguojama išskleidus priedo eilutę /priedai puslapyje. Atskira nuo parts_writeoffs.price (konkretaus nurašymo suma).';
