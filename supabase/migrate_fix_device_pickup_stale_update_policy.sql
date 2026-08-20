-- Paleisti Supabase Dashboard → SQL Editor.
--
-- migrate_add_device_pickups.sql sukūrė policy "Punkto žymėjimas paimtu
-- pagal 'edit' teisę" — paprastą UPDATE per RLS, leidžiantį klientui pačiam
-- nurodyti picked_by/picked_at/picked_location.
--
-- migrate_fix_device_pickups_two_step.sql šį žingsnį pakeitė
-- mark_device_picked() SECURITY DEFINER funkcija BŪTENT todėl, kad
-- tiesioginis UPDATE leido klientui nurodyti BET KIENO ID kaip paėmėją
-- (žr. tos migracijos komentarą prieš mark_device_picked() apibrėžimą).
-- Bet ji NIEKADA nepašalino senos UPDATE policy — jei jūsų DB šias dvi
-- migracijas paleido iš eilės, sena spraga (picked_by spoofing) vis dar
-- aktyvi lygiagrečiai su naująja funkcija, nes RLS politikos sumuojasi
-- (užtenka VIENOS leidžiančios, kad veiksmas praeitų).
--
-- schema.sql šios senos policy niekada neturėjo (§25 rašyta jau po two-step
-- pataisymo), todėl jam šis fix'as nereikalingas — tik esamai DB.

drop policy if exists "Punkto žymėjimas paimtu pagal 'edit' teisę" on public.device_pickups;
