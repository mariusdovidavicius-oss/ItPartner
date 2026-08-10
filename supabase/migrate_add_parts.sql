-- Paleisti Supabase Dashboard → SQL Editor
-- Prideda priedų (atsarginių dalių) sandėlio modulį prie esamos DB.
-- Nepriklausomas nuo paletžų/siuntų. Nėra unikalaus rakto per eilutę
-- šaltinio Excel duomenyse (part_code gali kartotis skirtingose
-- lokacijose — normalu), todėl importas visada veikia kaip insert, ne upsert.

create table if not exists public.parts (
  id                 uuid primary key default gen_random_uuid(),
  location           integer not null,                -- "Lokacija"
  main_model         text,                             -- "Pagrindinis Modelis"
  part_code          text not null,                    -- "Detalės Kodas" — text, nes formatas nevienodas (skaičius arba "352083/ZU21")
  name               text,                             -- "Pavadinimas"
  quantity           integer not null default 0,
  online_store       boolean not null default false,   -- "El. parduotuvė" TAIP/NE
  compatible_models  text,                              -- "Suderinami Modeliai", žalias tekstas
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.parts is 'Priedų (atsarginių dalių) sandėlio apskaita, importuojama iš Excel.';

create index if not exists parts_part_code_idx on public.parts (part_code);
create index if not exists parts_name_idx on public.parts (name);
create index if not exists parts_location_idx on public.parts (location);

-- set_updated_at() jau egzistuoja (sukurta items lentelei schema.sql/anksčiau
-- paleistose migracijose) — čia tik pakartotinai panaudojama.
drop trigger if exists parts_set_updated_at on public.parts;
create trigger parts_set_updated_at
  before update on public.parts
  for each row execute function public.set_updated_at();

alter table public.parts enable row level security;

create policy "Anon and authenticated full access - parts"
  on public.parts for all
  to anon, authenticated
  using (true)
  with check (true);

alter publication supabase_realtime add table public.parts;
