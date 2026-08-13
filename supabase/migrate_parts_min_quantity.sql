-- Paleisti Supabase Dashboard → SQL Editor
-- Individualus min. likučio slenkstis kiekvienam priedui — iki šiol "mažo
-- likučio" riba buvo fiksuota (3 vnt.) visiems priedams vienoda
-- (LOW_STOCK_THRESHOLD front-end pusėje). min_quantity leidžia kiekvienam
-- priedui nusistatyti savo ribą; kai NULL, naudojama numatytoji reikšmė
-- (3) — ta pati, kuri liko kaip fallback front-end pusėje formos placeholder'yje.
--
-- stock_level — generuojamas (stored) stulpelis, apskaičiuojantis
-- 'out' / 'low' / 'ok' pačioje DB, o ne front-end, kad /priedai puslapio
-- likučio filtras (PostgREST) galėtų filtruoti pagal jį paprastu .eq() —
-- filtruoti "quantity <= šios pačios eilutės min_quantity" tiesiogiai per
-- PostgREST užklausą neįmanoma (filtro reikšmė lyginama tik su konstanta,
-- ne su kitu tos pačios eilutės stulpeliu).

alter table public.parts
  add column if not exists min_quantity integer;

alter table public.parts
  drop constraint if exists parts_min_quantity_check;
alter table public.parts
  add constraint parts_min_quantity_check check (min_quantity is null or min_quantity >= 0);

alter table public.parts
  drop column if exists stock_level;
alter table public.parts
  add column stock_level text generated always as (
    case
      when quantity <= 0 then 'out'
      when quantity <= coalesce(min_quantity, 3) then 'low'
      else 'ok'
    end
  ) stored;

create index if not exists parts_stock_level_idx on public.parts (stock_level);
