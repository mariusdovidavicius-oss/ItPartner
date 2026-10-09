-- Paleisti Supabase Dashboard → SQL Editor
-- PALEIDIMO TVARKA: po migrate_dynamic_destination.sql.
--
-- Kelios atviros tos pačios paskirties paletės vienu metu. Viena iš jų —
-- "Kraunu čia" (is_loading): į ją ScanEntry deda nuskenuotus prietaisus.
-- Numeris paletei, kaip ir anksčiau, suteikiamas TIK ją uždarant ("Išvežta").
--
-- Taisyklės (palaiko trigeriai, kad nepriklausytų nuo to, kuris puslapis
-- keičia paletę):
--   * vienai paskirčiai — daugiausia viena atvira is_loading paletė;
--   * pažymėjus (ar sukūrus pažymėtą) paletę, kitų tos paskirties žymė nuimama;
--   * ne 'open' paletė niekada nėra is_loading;
--   * uždarius/ištrynus pažymėtą paletę, žymė pereina naujausiai likusiai
--     atvirai tos paskirties paletei (jei tokia yra).
-- Žymė bendra visiems įrenginiams (saugoma DB).
-- ------------------------------------------------------------

alter table public.pallets
  add column if not exists is_loading boolean not null default false;

comment on column public.pallets.is_loading is 'Atvira paletė, į kurią dedami nuskenuoti tos paskirties prietaisai ("Kraunu čia"). Viena paskirčiai.';

-- Esamos atviros paletės: kiekvienos paskirties naujausia tampa "Kraunu čia".
update public.pallets p
  set is_loading = true
  where p.status = 'open'
    and p.id = (
      select p2.id from public.pallets p2
      where p2.status = 'open' and p2.destination = p.destination
      order by p2.created_at desc, p2.id desc
      limit 1
    )
    and not exists (
      select 1 from public.pallets p3
      where p3.status = 'open' and p3.destination = p.destination and p3.is_loading
    );

create unique index if not exists pallets_one_loading_per_destination
  on public.pallets (destination)
  where status = 'open' and is_loading;

-- BEFORE: ne 'open' → žymė nuimama; nauja žymė → kitų tos paskirties nuimama.
create or replace function public.pallets_loading_before()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status <> 'open' then
    new.is_loading := false;
  end if;

  if new.status = 'open' and new.is_loading
     and (tg_op = 'INSERT' or not old.is_loading or old.destination is distinct from new.destination
          or old.status is distinct from new.status) then
    update public.pallets
      set is_loading = false
      where destination = new.destination
        and status = 'open'
        and is_loading
        and id <> new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists pallets_loading_before on public.pallets;
create trigger pallets_loading_before
  before insert or update on public.pallets
  for each row execute function public.pallets_loading_before();

-- AFTER: pažymėta paletė uždaryta/ištrinta/perkelta į kitą paskirtį → žymė
-- pereina naujausiai likusiai tos paskirties atvirai paletei. Kai žymė tik
-- nuimama (kita paletė pažymėta "Kraunu čia"), nieko nedaroma — kitaip
-- žymė būtų grąžinta ir susikirstų su naujai pažymėta.
create or replace function public.pallets_loading_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.is_loading
     and (tg_op = 'DELETE' or new.status <> 'open' or new.destination is distinct from old.destination) then
    update public.pallets
      set is_loading = true
      where id = (
        select id from public.pallets
        where destination = old.destination and status = 'open'
          and (tg_op = 'DELETE' or id <> old.id)
        order by created_at desc, id desc
        limit 1
      )
      and not exists (
        select 1 from public.pallets
        where destination = old.destination and status = 'open' and is_loading
      );
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists pallets_loading_after on public.pallets;
create trigger pallets_loading_after
  after update or delete on public.pallets
  for each row execute function public.pallets_loading_after();
