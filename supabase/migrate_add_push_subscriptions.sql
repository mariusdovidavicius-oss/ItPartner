-- Paleisti Supabase Dashboard → SQL Editor
-- PALEIDIMO TVARKA: nepriklauso nuo kitų migracijų.
--
-- Web Push pranešimai apie naujus priskirtus darbus (pvz. "Paruošti
-- išsiuntimui"). Kiekviena naršyklė/įrenginys, kuriame vartotojas įjungė
-- pranešimus, — viena eilutė (endpoint — naršyklės pranešimų tarnybos
-- adresas, p256dh/auth — šifravimo raktai). Pranešimus siunčia api/push.js
-- su service_role raktu, todėl SELECT kitiems vartotojams nereikalingas.
-- ------------------------------------------------------------

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);

comment on table public.push_subscriptions is 'Web Push prenumeratos (vienas įrenginys/naršyklė = viena eilutė).';

create index if not exists push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subscriptions_select_own" on public.push_subscriptions;
create policy "push_subscriptions_select_own" on public.push_subscriptions
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "push_subscriptions_delete_own" on public.push_subscriptions;
create policy "push_subscriptions_delete_own" on public.push_subscriptions
  for delete to authenticated
  using (user_id = auth.uid());

-- Išsaugo šios naršyklės prenumeratą dabartiniam vartotojui. Per security
-- definer, kad bendrame kompiuteryje (ta pati naršyklė = tas pats endpoint)
-- prenumerata pereitų prisijungusiam vartotojui — paprastas upsert
-- atsitrenktų į kito vartotojo eilutės RLS.
create or replace function public.save_push_subscription(
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Reikia prisijungti.';
  end if;
  if coalesce(trim(p_endpoint), '') = '' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'Neteisinga prenumerata.';
  end if;

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, p_user_agent)
  on conflict (endpoint) do update
    set user_id    = excluded.user_id,
        p256dh     = excluded.p256dh,
        auth       = excluded.auth,
        user_agent = excluded.user_agent,
        created_at = now();
end;
$$;

revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
