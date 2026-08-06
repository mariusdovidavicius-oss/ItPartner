-- Paleisti Supabase Dashboard → SQL Editor
-- Prideda shipments funkcionalumą prie esamos DB (be konfliktų su egzistuojančiomis policy)

-- 1. Nauja shipments lentelė
create table if not exists public.shipments (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  status      text not null default 'open'
              check (status in ('open', 'sent')),
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

alter table public.shipments enable row level security;

create policy "Anon and authenticated full access - shipments"
  on public.shipments for all
  to anon, authenticated
  using (true)
  with check (true);

alter publication supabase_realtime add table public.shipments;

-- 2. Nauji stulpeliai pallets lentelėje
alter table public.pallets
  add column if not exists shipment_id uuid references public.shipments (id) on delete set null,
  add column if not exists packed_at   timestamptz;

create index if not exists pallets_shipment_id_idx on public.pallets (shipment_id);

-- 3. Trigeris: uždarius paletę → automatiškai priskirti siuntai
create or replace function public.auto_assign_shipment()
returns trigger as $$
declare
  v_shipment_id uuid;
  v_date_str    text;
  v_seq         int;
  v_code        text;
begin
  if new.status = 'closed' and old.status is distinct from 'closed' then
    if new.packed_at is null then
      new.packed_at := now();
    end if;
    if new.shipment_id is null then
      select id into v_shipment_id
        from public.shipments
       where status = 'open'
       order by created_at desc
       limit 1;
      if v_shipment_id is null then
        v_date_str := to_char(now(), 'YYYY-MM-DD');
        select count(*) + 1 into v_seq
          from public.shipments
         where to_char(created_at, 'YYYY-MM-DD') = v_date_str;
        v_code := 'SIUNTA-' || v_date_str || '-' || lpad(v_seq::text, 2, '0');
        insert into public.shipments (code, status) values (v_code, 'open')
          returning id into v_shipment_id;
      end if;
      new.shipment_id := v_shipment_id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists pallets_auto_assign_shipment on public.pallets;
create trigger pallets_auto_assign_shipment
  before update on public.pallets
  for each row execute function public.auto_assign_shipment();
