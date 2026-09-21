-- Paleisti Supabase Dashboard → SQL Editor
-- Statistikos puslapio (/statistika) agregatai vienoje DB pusėje.
--
-- Anksčiau puslapis tempė visas parts/parts_writeoffs/device_* eilutes į
-- naršyklę ir sumavo ten. Supabase vienu atsakymu grąžina ne daugiau kaip
-- max_rows (pagal numatymą 1000) eilučių, todėl priedų/nurašymų skaičiui
-- perkopus 1000 sumos tyliai tapdavo per mažos. Dabar skaičiuoja DB, o
-- naršyklė gauna tik paruoštą JSON.
--
-- SECURITY INVOKER (numatytasis) — funkcijos vykdomos UŽKLAUSĖJO teisėmis,
-- todėl galioja tos pačios RLS taisyklės, kaip ir tiesioginėms užklausoms:
-- parts/devices/device_stock peržiūra vieša, o parts_writeoffs/device_writeoffs
-- rodomi tik su 'delete' teise (be jos nurašymų dalis grįžta tuščia).
--
-- Skaičiuojami TIK aktyvūs (neatšaukti, undone_at is null) nurašymai;
-- p_from = NULL reiškia "visas laikotarpis". price — SUMA UŽ VISĄ nurašomą
-- kiekį (ne už vienetą), todėl sumuojama be dauginimo.
--
-- top_items grupuojamas pagal detalės kodą + pavadinimą (priedai) arba IAN +
-- pavadinimą (prietaisai), todėl tas pats priedas skirtingose lokacijose
-- (skirtingos parts eilutės) rodomas vienu įrašu.

create or replace function public.parts_stats(p_from timestamptz default null)
returns jsonb
language sql
stable
set search_path = public
as $$
  with active as (
    select w.quantity, w.reason_type, w.price, p.part_code, p.name, p.main_model
    from public.parts_writeoffs w
    join public.parts p on p.id = w.part_id
    where w.undone_at is null
      and (p_from is null or w.created_at >= p_from)
  )
  select jsonb_build_object(
    'overview', (
      select jsonb_build_object(
        'total_parts', count(*),
        'total_units', coalesce(sum(quantity), 0),
        'low_count',   count(*) filter (where stock_level = 'low'),
        'out_count',   count(*) filter (where stock_level = 'out')
      )
      from public.parts
    ),
    'writeoffs', jsonb_build_object(
      'total_qty', (select coalesce(sum(quantity), 0) from active),
      'revenue',   (select coalesce(sum(price) filter (where reason_type = 'parduota'), 0) from active),
      'by_reason', (
        select coalesce(jsonb_object_agg(reason_type, jsonb_build_object('count', c, 'qty', q)), '{}'::jsonb)
        from (
          select reason_type, count(*) as c, sum(quantity) as q
          from active
          group by reason_type
        ) r
      )
    ),
    'top_items', (
      select coalesce(jsonb_agg(
        jsonb_build_object('label', label, 'code', part_code, 'model', model, 'qty', qty)
        order by qty desc, label
      ), '[]'::jsonb)
      from (
        select
          coalesce(nullif(name, ''), part_code) as label,
          part_code,
          min(main_model) as model,
          sum(quantity) as qty
        from active
        group by part_code, coalesce(nullif(name, ''), part_code)
        order by sum(quantity) desc, coalesce(nullif(name, ''), part_code)
        limit 5
      ) t
    )
  );
$$;

create or replace function public.device_stats(p_from timestamptz default null)
returns jsonb
language sql
stable
set search_path = public
as $$
  with active as (
    select w.quantity, w.reason_type, w.price, w.device_ian, w.device_name
    from public.device_writeoffs w
    where w.undone_at is null
      and (p_from is null or w.created_at >= p_from)
  )
  select jsonb_build_object(
    'overview', jsonb_build_object(
      'total_devices',  (select count(*) from public.devices),
      'total_units',    (select coalesce(sum(total_quantity), 0) from public.device_totals),
      'low_count',      (select count(*) from public.device_totals where stock_level = 'low'),
      'out_count',      (select count(*) from public.device_totals where stock_level = 'out'),
      'location_count', (select count(*) from public.device_stock)
    ),
    'writeoffs', jsonb_build_object(
      'total_qty', (select coalesce(sum(quantity), 0) from active),
      'revenue',   (select coalesce(sum(price) filter (where reason_type = 'parduota'), 0) from active),
      'by_reason', (
        select coalesce(jsonb_object_agg(reason_type, jsonb_build_object('count', c, 'qty', q)), '{}'::jsonb)
        from (
          select reason_type, count(*) as c, sum(quantity) as q
          from active
          group by reason_type
        ) r
      )
    ),
    'top_items', (
      select coalesce(jsonb_agg(
        jsonb_build_object('label', label, 'code', device_ian, 'model', null, 'qty', qty)
        order by qty desc, label
      ), '[]'::jsonb)
      from (
        select
          coalesce(nullif(device_name, ''), device_ian) as label,
          device_ian,
          sum(quantity) as qty
        from active
        group by device_ian, coalesce(nullif(device_name, ''), device_ian)
        order by sum(quantity) desc, coalesce(nullif(device_name, ''), device_ian)
        limit 5
      ) t
    )
  );
$$;

revoke all on function public.parts_stats(timestamptz) from public, anon;
revoke all on function public.device_stats(timestamptz) from public, anon;
grant execute on function public.parts_stats(timestamptz) to authenticated;
grant execute on function public.device_stats(timestamptz) to authenticated;
