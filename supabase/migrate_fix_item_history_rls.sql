-- Paleisti Supabase Dashboard → SQL Editor
--
-- Klaida: "new row violates row-level security policy for table
-- 'item_history'" bandant pakeisti prekės status (pvz. šalinant prekę iš
-- paletės PalletDetail puslapyje, arba bet kokį kitą status pasikeitimą).
--
-- Priežastis: trigerio funkcija log_item_status_change() (fiksuoja kiekvieną
-- items.status pasikeitimą į item_history audito lentelę) NETURĖJO
-- SECURITY DEFINER — todėl vykdoma iškvietusio vartotojo (anon/authenticated)
-- teisėmis. O item_history RLS leidžia tik SELECT, jokio INSERT niekam
-- neleista — todėl trigerio INSERT visada atmetamas, kad ir kas keistų
-- prekės būseną.
--
-- Pataisymas: pridedamas SECURITY DEFINER (kaip ir visoms kitoms pagalbinių
-- lentelių trigerio funkcijoms šioje schemoje), kad įrašymas į item_history
-- vyktų funkcijos savininko teisėmis, apeinant RLS.

create or replace function public.log_item_status_change()
returns trigger as $$
begin
  if old.status is distinct from new.status then
    insert into public.item_history (item_id, old_status, new_status)
    values (new.id, old.status, new.status);
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;
