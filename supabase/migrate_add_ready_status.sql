-- Paleisti Supabase Dashboard → SQL Editor
-- Prideda naują tarpinę paletžų būseną "ready" (paruošta išvežimui) tarp
-- "closed" (uždaryta) ir realaus išvežimo per shipment. Nauja pilna seka:
-- open -> closed -> ready -> (priskyrimas shipment su status='sent').
--
-- Priežastis: paletės susikaupia uždarytos, bet ne visos iškart išvežamos —
-- reikia galimybės pažymėti DALĮ uždarytų paletžų kaip "paruoštas" kitam
-- transporto atvykimui, o likusias palikti laukti kito karto.
--
-- Paveikta TIK "status" stulpelio CHECK apribojimas. "packed_at" trigeris
-- (set_pallet_packed_at) reaguoja TIK į perėjimą į 'closed' ir NEKEIČIAMAS —
-- jis jau užpildomas uždarant paletę, o pažymint ją "paruošta" (closed ->
-- ready) šis laukas turi likti nepakeistas (kaip uždarymo data), ne perrašomas.
-- Panašiai "decrement_pallet_counter_on_delete" trigeris filtruoja pagal
-- shipment_id, o ne status, todėl irgi nekeičiamas.

alter table public.pallets drop constraint if exists pallets_status_check;
alter table public.pallets add constraint pallets_status_check
  check (status in ('open', 'closed', 'ready', 'shipped', 'delivered'));
