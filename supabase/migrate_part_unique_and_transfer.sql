-- Paleisti Supabase Dashboard → SQL Editor
-- PALEIDIMO TVARKA: po migrate_add_part_warehouses.sql.
--
-- 1) Tas pats priedas (detalės kodas) tame pačiame sandėlyje + lokacijoje
--    gali būti TIK viena parts eilutė. Palyginimas — be tarpų kraštuose ir
--    neatsižvelgiant į raidžių dydį (lt_lower), t.y. "42a" = "42A ".
--    Priedams be numerio ("N/A", tuščias, "-") unikalumas netaikomas.
--    Jau esantys dublikatai prieš kuriant indeksą sujungiami į seniausią
--    eilutę (žr. 0 žingsnį). Patikrinti, ar jų yra:
--      select warehouse_id, lt_lower(trim(location)), lt_lower(trim(part_code)), count(*)
--        from parts group by 1, 2, 3 having count(*) > 1;
-- 2) import_parts() — pasikartojančios failo eilutės sujungiamos (kiekiai
--    sudedami), o jau esantis priedas ATNAUJINAMAS (kiekis perrašomas failo
--    reikšme), ne dubliuojamas.
-- 3) transfer_part_stock() — priedo kiekio perkėlimas į kitą sandėlį/lokaciją.
-- ------------------------------------------------------------

-- 0) Esami dublikatai (tas pats kodas tame pačiame sandėlyje + lokacijoje)
-- sujungiami į seniausią eilutę: kiekiai sudedami, tušti laukai užpildomi
-- iš kitų eilučių, kitų eilučių pagrindiniai modeliai pridedami prie
-- suderinamų (jei jų ten dar nėra), nurašymai perkeliami, dublikatai ištrinami.
drop table if exists _dup_map;
create temp table _dup_map as
select id, canon
from (
  select
    id,
    first_value(id) over (
      partition by warehouse_id, public.lt_lower(trim(location)), public.lt_lower(trim(part_code))
      order by created_at, id
    ) as canon,
    count(*) over (
      partition by warehouse_id, public.lt_lower(trim(location)), public.lt_lower(trim(part_code))
    ) as cnt
  from public.parts
  where lower(trim(part_code)) not in ('', 'n/a', 'na', '-')
) t
where cnt > 1;

update public.parts c
  set quantity          = m.quantity,
      online_store      = m.online_store,
      name              = coalesce(nullif(trim(c.name), ''), m.name),
      price             = coalesce(c.price, m.price),
      min_quantity      = coalesce(c.min_quantity, m.min_quantity),
      notes             = m.notes,
      compatible_models = concat_ws(E'\n', nullif(trim(c.compatible_models), ''), m.extra_models)
  from (
    select
      d.canon,
      sum(p.quantity)::integer as quantity,
      bool_or(p.online_store) as online_store,
      (array_agg(p.name order by p.created_at, p.id) filter (where nullif(trim(p.name), '') is not null))[1] as name,
      (array_agg(p.price order by p.created_at, p.id) filter (where p.price is not null))[1] as price,
      (array_agg(p.min_quantity order by p.created_at, p.id) filter (where p.min_quantity is not null))[1] as min_quantity,
      string_agg(distinct nullif(trim(p.notes), ''), E'\n') as notes,
      string_agg(distinct trim(p.main_model), E'\n') filter (
        where d.id <> d.canon
          and nullif(trim(p.main_model), '') is not null
          and public.lt_lower(trim(p.main_model)) <> public.lt_lower(trim(coalesce(k.main_model, '')))
          and strpos(public.lt_lower(coalesce(k.compatible_models, '')), public.lt_lower(trim(p.main_model))) = 0
      ) as extra_models
    from public.parts p
    join _dup_map d on d.id = p.id
    join public.parts k on k.id = d.canon
    group by d.canon
  ) m
  where c.id = m.canon;

update public.parts_writeoffs w
  set part_id = d.canon
  from _dup_map d
  where d.id = w.part_id and d.id <> d.canon;

delete from public.parts p
  using _dup_map d
  where d.id = p.id and d.id <> d.canon;

drop table _dup_map;

-- "N/A" (ir tuščias/"-") = detalė neturi numerio — tokie priedai yra
-- SKIRTINGI daiktai (pvz. šlifavimo lapeliai K80/K100 toje pačioje dėžėje),
-- tad unikalumas jiems netaikomas (dalinis indeksas).
create unique index if not exists parts_warehouse_location_code_unique
  on public.parts (warehouse_id, public.lt_lower(trim(location)), public.lt_lower(trim(part_code)))
  where lower(trim(part_code)) not in ('', 'n/a', 'na', '-');

-- ------------------------------------------------------------
-- import_parts() — grąžina json {inserted, updated} (anksčiau integer).
-- Esamo priedo atnaujinimas: kiekis perrašomas; tekstiniai laukai
-- perrašomi tik jei faile netušti; online_store — tik jei eilutėje yra
-- raktas 'online_store' (front-end jį siunčia tik kai stulpelis susietas).
-- Front-end jau sujungia dublikatus per VISĄ failą (ne tik vieną dalį),
-- čia group by — apsauga, kad ON CONFLICT neliestų tos pačios eilutės du kartus.
-- ------------------------------------------------------------
drop function if exists public.import_parts(jsonb, boolean, uuid[]);

create or replace function public.import_parts(
  rows jsonb,
  clear_existing boolean default false,
  p_clear_warehouse_ids uuid[] default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer;
  v_updated  integer;
  v_has_online_store boolean := exists (
    select 1 from jsonb_array_elements(rows) as r where r ? 'online_store'
  );
begin
  if not public.has_permission(auth.uid(), 'import') then
    raise exception 'Neturite importo teisės.';
  end if;

  if clear_existing then
    if not public.has_permission(auth.uid(), 'delete') then
      raise exception 'Norint prieš importą išvalyti esamus duomenis, reikia trynimo teisės.';
    end if;
    if p_clear_warehouse_ids is null or cardinality(p_clear_warehouse_ids) = 0 then
      raise exception 'Nenurodyta, kurių sandėlių priedus išvalyti.';
    end if;
    delete from public.parts where warehouse_id = any (p_clear_warehouse_ids);
  end if;

  with src as (
    select
      w.id as warehouse_id,
      trim(r->>'location') as location,
      trim(r->>'part_code') as part_code,
      nullif(r->>'main_model', '') as main_model,
      nullif(r->>'name', '') as name,
      coalesce((r->>'quantity')::integer, 0) as quantity,
      coalesce((r->>'online_store')::boolean, false) as online_store,
      nullif(r->>'compatible_models', '') as compatible_models
    from jsonb_array_elements(rows) as r
    join public.warehouses w
      on public.lt_lower(trim(w.name)) = public.lt_lower(trim(r->>'warehouse'))
    where coalesce(trim(r->>'part_code'), '') <> '' and r->>'location' is not null
  ),
  grouped as (
    select
      warehouse_id,
      min(location) as location,
      min(part_code) as part_code,
      max(main_model) as main_model,
      max(name) as name,
      sum(quantity)::integer as quantity,
      bool_or(online_store) as online_store,
      max(compatible_models) as compatible_models
    from src
    -- Be numerio (N/A) eilutės nejungiamos — kiekviena lieka atskira (id).
    group by warehouse_id, public.lt_lower(location), public.lt_lower(part_code),
             case when lower(part_code) in ('', 'n/a', 'na', '-') then gen_random_uuid() end
  ),
  upserted as (
    insert into public.parts (warehouse_id, location, part_code, main_model, name, quantity, online_store, compatible_models)
    select warehouse_id, location, part_code, main_model, name, quantity, online_store, compatible_models
    from grouped
    on conflict (warehouse_id, public.lt_lower(trim(location)), public.lt_lower(trim(part_code)))
      where lower(trim(part_code)) not in ('', 'n/a', 'na', '-')
      do update
      set quantity          = excluded.quantity,
          main_model        = coalesce(excluded.main_model, public.parts.main_model),
          name              = coalesce(excluded.name, public.parts.name),
          compatible_models = coalesce(excluded.compatible_models, public.parts.compatible_models),
          online_store      = case when v_has_online_store then excluded.online_store
                                   else public.parts.online_store end,
          updated_at        = now()
    returning (xmax = 0) as was_inserted
  )
  select count(*) filter (where was_inserted), count(*) filter (where not was_inserted)
    into v_inserted, v_updated
    from upserted;

  return json_build_object('inserted', v_inserted, 'updated', v_updated);
end;
$$;

revoke all on function public.import_parts(jsonb, boolean, uuid[]) from public, anon;
grant execute on function public.import_parts(jsonb, boolean, uuid[]) to authenticated;

-- ------------------------------------------------------------
-- transfer_part_stock() — priedo kiekio perkėlimas į kitą vietą (bet kuris
-- sandėlis + lokacija). Bendras kiekis nesikeičia, tad pakanka 'edit' teisės.
-- Atomiška, šaltinio eilutė užrakinama:
--  * tikslinėje vietoje TAS PATS kodas jau yra → kiekiai sudedami;
--    perkėlus VISĄ kiekį šaltinis ištrinamas (dvi eilutės susilieja), o jo
--    nurašymų istorija (parts_writeoffs) perkeliama į tikslą, kad
--    neišsitrintų (FK on delete cascade);
--  * tikslinėje vietoje kodo nėra ir perkeliamas VISAS kiekis → tiesiog
--    pakeičiamas šaltinio sandėlis/lokacija (id ir istorija lieka);
--  * perkeliama DALIS į naują vietą → sukuriama nauja eilutė su šaltinio
--    duomenimis (pavadinimas, modelis, kaina, min. likutis ir t.t.).
-- Grąžina tikslinės parts eilutės id.
-- ------------------------------------------------------------
create or replace function public.transfer_part_stock(
  p_part_id uuid,
  p_to_warehouse_id uuid,
  p_to_location text,
  p_quantity integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src        public.parts%rowtype;
  v_location   text := trim(coalesce(p_to_location, ''));
  v_target_id  uuid;
begin
  if not public.has_permission(auth.uid(), 'edit') then
    raise exception 'Neturite teisės perkelti priedų.';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Perkeliamas kiekis turi būti didesnis už nulį.';
  end if;

  if v_location = '' then
    raise exception 'Įveskite lokaciją.';
  end if;

  if not exists (select 1 from public.warehouses where id = p_to_warehouse_id) then
    raise exception 'Sandėlis nerastas.';
  end if;

  select * into v_src from public.parts where id = p_part_id for update;
  if v_src.id is null then
    raise exception 'Priedas nerastas.';
  end if;
  if p_quantity > v_src.quantity then
    raise exception 'Perkeliamas kiekis (%) negali viršyti turimo likučio (%).', p_quantity, v_src.quantity;
  end if;

  -- Priedas be numerio (N/A) niekada nejungiamas su kitu (kiti N/A — kiti daiktai).
  select id into v_target_id
    from public.parts
    where warehouse_id = p_to_warehouse_id
      and public.lt_lower(trim(location)) = public.lt_lower(v_location)
      and public.lt_lower(trim(part_code)) = public.lt_lower(trim(v_src.part_code))
      and lower(trim(v_src.part_code)) not in ('', 'n/a', 'na', '-')
    for update;

  if v_target_id = p_part_id then
    raise exception 'Perkelti į tą pačią vietą negalima.';
  end if;

  if v_target_id is not null then
    update public.parts set quantity = quantity + p_quantity where id = v_target_id;
    if p_quantity = v_src.quantity then
      update public.parts_writeoffs set part_id = v_target_id where part_id = p_part_id;
      delete from public.parts where id = p_part_id;
    else
      update public.parts set quantity = quantity - p_quantity where id = p_part_id;
    end if;
    return v_target_id;
  end if;

  if p_quantity = v_src.quantity then
    update public.parts
      set warehouse_id = p_to_warehouse_id, location = v_location
      where id = p_part_id;
    return p_part_id;
  end if;

  update public.parts set quantity = quantity - p_quantity where id = p_part_id;

  insert into public.parts (warehouse_id, location, main_model, part_code, name, quantity,
                            min_quantity, online_store, compatible_models, notes, price)
  values (p_to_warehouse_id, v_location, v_src.main_model, v_src.part_code, v_src.name, p_quantity,
          v_src.min_quantity, v_src.online_store, v_src.compatible_models, v_src.notes, v_src.price)
  returning id into v_target_id;

  return v_target_id;
end;
$$;

revoke all on function public.transfer_part_stock(uuid, uuid, text, integer) from public, anon;
grant execute on function public.transfer_part_stock(uuid, uuid, text, integer) to authenticated;
