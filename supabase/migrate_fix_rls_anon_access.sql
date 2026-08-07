-- Paleisti Supabase Dashboard → SQL Editor
--
-- Radinys per RLS/trigerių auditą: programa NIEKADA nenaudoja Supabase Auth
-- (src/lib/supabaseClient.js visur naudoja tik VITE_SUPABASE_ANON_KEY, jokio
-- supabase.auth iškvietimo) — todėl KIEKVIENA užklausa iš aplikacijos
-- vykdoma kaip "anon" rolė, niekada "authenticated".
--
-- Bet užfiksuotas schema.sql (iki šio pataisymo) pallets/items/catalog
-- lentelėms leisdavo veiksmus TIK "to authenticated". Kadangi aplikacija
-- realiai veikia, tai reiškia, kad jūsų gyva duomenų bazė jau turi kitokias
-- (anon leidžiančias) taisykles nei užfiksuota kode — tikriausiai rankiniu
-- būdu pakeista kada nors anksčiau, bet niekur neužrašyta. Šis skriptas
-- SUVIENODINA — padaro, kad kodas TIKSLIAI atitiktų tai, kas realiai
-- turi veikti, kad DB atkūrimas iš schema.sql ateityje veiktų iš karto,
-- be jokių pamirštų rankinių žingsnių.
--
-- SVARBU: kaip ir jau esama "shipments" politika, tai reiškia, kad BET KAS,
-- turintis anon raktą (t. y. bet kas, kas pasiekia aplikaciją), gali atlikti
-- bet kokį veiksmą su šiomis lentelėmis. Aplikacija NETURI būti pasiekiama
-- iš viešo interneto be papildomos apsaugos (VPN, IP apribojimas ir pan.).

drop policy if exists "Authenticated full access - pallets" on public.pallets;
create policy "Anon and authenticated full access - pallets"
  on public.pallets for all
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Authenticated full access - items" on public.items;
create policy "Anon and authenticated full access - items"
  on public.items for all
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Authenticated read access - item_history" on public.item_history;
create policy "Anon and authenticated read access - item_history"
  on public.item_history for select
  to anon, authenticated
  using (true);

drop policy if exists "Authenticated full access - catalog" on public.catalog;
create policy "Anon and authenticated full access - catalog"
  on public.catalog for all
  to anon, authenticated
  using (true)
  with check (true);
