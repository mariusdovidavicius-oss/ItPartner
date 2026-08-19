# Sandėlio valdymo sistema (IAN skenavimas, paletės, siuntos) + priedų sandėlis

Vidinė valdymo sistema, pakeičianti Excel/Google Sheets lentelę. Du domenai vienoje aplikacijoje:

1. **Pagrindinis sandėlio srautas** — prekių registravimas pagal IAN kodą, realaus laiko lentelė, automatinis paskirstymas į paletes pagal gamintoją/tipą, palečių grupavimas į siuntas ir būsenų valdymas, paieška ir redagavimas. Šis srautas veikia be prisijungimo (`anon` prieiga).
2. **Priedų (atsarginių dalių) sandėlio modulis** (`/priedai`) — atskira, nepriklausoma prekių apskaita su Supabase Auth prisijungimu ir granuliuotomis vartotojų teisėmis (peržiūra/redagavimas/trynimas/importas/admin).

**Stack:** Vite + React + React Router + Tailwind CSS + Supabase (PostgreSQL, Auth, Realtime) + ExcelJS Excel eksportui/importui (CSV skaitomas savo, be priklausomybių, parseriu). Vercel serverless funkcija (`api/create-user.js`) vartotojų kūrimui.

## 1. Projekto struktūra

```
warehouse-app/
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── vercel.json                    ← Vercel deploy konfigūracija
├── .env.example                   ← nukopijuokite į .env
├── api/
│   └── create-user.js             ← Vercel serverless: naujo priedų modulio vartotojo kūrimas (service_role raktu)
├── scripts/
│   └── bootstrap-admin.mjs        ← vienkartinis CLI skriptas pirmam admin vartotojui sukurti
├── supabase/
│   ├── schema.sql                 ← pilna, dabartinė schema (paleidžiama naujai DB)
│   └── migrate_*.sql              ← papildomos migracijos jau egzistuojančiai DB, chronologine tvarka:
│       add_quantity, add_destination, dynamic_destination, shipments,
│       manual_shipment_selection, pallet_number, drop_pallet_code_unique,
│       reset_function, reset_pallet_numbering, reset_numbering_on_ready,
│       add_ready_status, ready_position_renumbering, gap_fill_pallet_numbering,
│       two_queue_numbering, simple_close_numbering, pallet_delete_counter,
│       fix_shipment_reset_trigger, fix_rls_anon_access, fix_item_history_rls,
│       add_parts, add_parts_notes, add_parts_permissions,
│       fix_import_parts_delete_permission, admin_reset_require_admin,
│       add_parts_writeoffs, parts_public_view, parts_writeoffs_reason_type,
│       parts_min_quantity, writeoff_undo, add_pallet_permissions,
│       add_catalog_permission, add_devices, devices_notes, add_device_writeoffs,
│       fix_device_totals_security_invoker, fix_import_devices_coalesce,
│       fix_device_writeoffs_denormalize, devices_public_view,
│       add_device_pickups, fix_device_pickups_two_step,
│       add_device_pickup_unpick, add_device_min_quantity
│       (žr. 2 skyrių)
└── src/
    ├── main.jsx
    ├── App.jsx                    ← maršrutai (routes)
    ├── index.css                   ← Tailwind + bendri stiliai
    ├── lib/
    │   ├── supabaseClient.js       ← Supabase klientas
    │   ├── AuthProvider.jsx        ← prisijungimo kontekstas (Supabase Auth sesija, profilis, teisės, `signInWithId`)
    │   ├── authConstants.js        ← ID → vidinis el. paštas (`<id>@parts.local`) konvertavimas
    │   ├── permissions.js          ← priedų modulio teisių sąrašas (view/edit/delete/import)
    │   ├── constants.js            ← būsenų sąrašai (ITEM/PALLET/SHIPMENT) ir spalvos
    │   ├── destination.js          ← "paskirties" (destination) skaičiavimas iš gamintojo+tipo
    │   ├── excelHeaders.js         ← Excel stulpelių antraščių atspėjimas importuojant
    │   ├── readSpreadsheet.js      ← Excel (.xlsx, per ExcelJS) arba CSV (savas parseris) skaitymas į eilučių masyvą, naudojamas importo puslapiuose
    │   ├── exportExcel.js          ← Excel eksportas (paletės, siuntos, priedai, priedų nurašymai)
    │   ├── printLabel.js           ← paletės etikečių spausdinimas
    │   └── readTransferPdf.js      ← vidinės sistemos "Internal transfer" PDF nuskaitymas naršyklėje (pdfjs-dist, lazy-load), naudojamas /prietaisai/atsinesimai PDF importe
    ├── components/
    │   ├── Layout.jsx               ← viršutinė juosta (prisijungimas/atsijungimas) + šoninė/apatinė navigacija (grupuota pagal modulį)
    │   ├── RequirePermission.jsx    ← route guard: reikalauja prisijungimo (rodo `InlineLoginForm` tame pačiame puslapyje), o su `permission` — ir konkrečios teisės
    │   ├── InlineLoginForm.jsx      ← prisijungimo forma, įterpiama tiesiog puslapyje (variantai "panel"/"bar"), be atskiro `/login` maršruto
    │   ├── StatusBadge.jsx
    │   └── DestinationBadge.jsx
    └── pages/
        ├── ScanEntry.jsx             ← "/" — IAN skenavimas/registravimas, atviros paletės
        ├── Pallets.jsx               ← "/paletes" — laukiančios paletės, rankinis siuntų formavimas, Excel eksportas
        ├── PalletDetail.jsx          ← "/paletes/:id" — paletės turinys, būsenos keitimas, prekės pašalinimas
        ├── ShipmentsList.jsx         ← "/siuntos" — jau išsiųstų siuntų sąrašas + IAN paieška tarp išvežtų prekių
        ├── ShipmentDetail.jsx        ← "/siuntos/:id" — siuntos turinys (paletės, prekės), Excel eksportas, etikečių spausdinimas
        ├── Parts.jsx                 ← "/priedai" — priedų sąrašas, paieška, Excel eksportas (peržiūra dabar vieša, be prisijungimo); su "edit"/"delete" teise — redagavimas ir priedo nurašymas (`writeoff_part` RPC)
        ├── PartsImport.jsx           ← "/priedai/importas" — priedų importas iš Excel/CSV (reikia "import" teisės)
        ├── PartsWriteoffs.jsx        ← "/priedai/nurasymai" — visų priedų nurašymų istorija, paieška/filtras pagal priežastį, atšaukimas, Excel eksportas (reikia "delete" teisės)
        ├── PartsUsers.jsx            ← "/priedai/vartotojai" — vartotojų kūrimas ir teisių valdymas (reikia "admin" teisės)
        ├── CatalogImport.jsx         ← "/katalogas" — admin: katalogo (IAN → pavadinimas/gamintojas/tipas) importas iš Excel/CSV
        ├── AdminReset.jsx            ← "/admin-reset" — admin: visų testavimo duomenų išvalymas (reikia "admin" teisės)
        ├── Devices.jsx               ← "/prietaisai" — prietaisų sąrašas su lokacijų išskleidimu, paieška, Excel eksportas (peržiūra vieša, be prisijungimo); su "delete" teise — trys veiksmų mygtukai (Redaguoti/Nurašyti/Ištrinti, `writeoff_device` RPC) ir istorija išskleistoje eilutėje; su "edit" teise — mygtukas „Atsinešti" TIESIOG PAGRINDINĖJE lentelės eilutėje (be išskleidimo), pridedantis punktą į `device_pickups`
        ├── DevicesImport.jsx         ← "/prietaisai/importas" — prietaisų importas iš Excel/CSV (reikia "import" teisės)
        ├── DeviceWriteoffs.jsx       ← "/prietaisai/nurasymai" — visų prietaisų nurašymų istorija, paieška/filtras pagal priežastį, atšaukimas, Excel eksportas (reikia "delete" teisės)
        ├── DevicePickups.jsx         ← "/prietaisai/atsinesimai" — garantinio serviso atsinešimų sąrašo peržiūra (laukia/paimta/nurašyta) ir valdymas (punktai PRIDEDAMI iš Devices.jsx, ne čia); pridėti/trinti/žymėti "paimta" — "edit" teisė, "Nurašyti" (kiekio atėmimas) — papildomai "delete" teisė
        └── Stats.jsx                 ← "/statistika" — VIENAS bendras statistikos puslapis visam projektui; viduje perjungiama Priedai/Prietaisai (rodomi tik moduliai, kuriuos vartotojas realiai mato), sandėlio ir nurašymų apžvalga, realaus laiko atnaujinimas
```

Puslapis `/katalogas` yra administracinis — pasiekiamas tik tiesioginiu adresu, be nuorodos navigacijos meniu. `/priedai/importas`, `/priedai/nurasymai`, `/priedai/vartotojai`, `/admin-reset`, `/prietaisai/importas`, `/prietaisai/nurasymai` apsaugoti `RequirePermission` komponentu (žr. žemiau) — be prisijungimo rodoma prisijungimo forma tame pačiame puslapyje (`InlineLoginForm`, ne atskiras `/login` maršrutas), o be reikiamos teisės parodomas pranešimas apie teisių trūkumą. **Ir `/priedai`, IR `/prietaisai` sąrašo peržiūra yra vieša** (žr. `migrate_parts_public_view.sql` / `migrate_devices_public_view.sql`) — redagavimas/trynimas/nurašymas gated pačiame `Parts.jsx`/`Devices.jsx` puslapyje pagal turimą teisę; neprisijungusiam vartotojui abiejuose rodoma ta pati „Peržiūros režimas“ juosta.

### Priedų modulio prisijungimas ir teisės

Vartotojai neturi el. pašto — jungiasi trumpu **ID** (pvz. `marius`), kuris front-end pusėje paverčiamas į vidinį `<id>@parts.local` formatą Supabase Auth reikmėms (`src/lib/authConstants.js`). Prisijungimo forma (`InlineLoginForm`) rodoma tiesiog viršutinėje juostoje (`Layout.jsx`) arba apsaugoto puslapio viduje (`RequirePermission`) — atskiro `/login` maršruto nebėra. Teisės (`view`/`edit`/`delete`/`import`) saugomos `user_permissions` lentelėje po vieną eilutę kiekvienai; `is_admin` (lentelėje `profiles`) automatiškai suteikia visas teises ir prieigą prie `/priedai/vartotojai`, `/admin-reset`. Naujus vartotojus kuria tik administratorius:

- per UI: `/priedai/vartotojai` → kviečia `api/create-user.js` (Vercel serverless funkcija, naudoja `SUPABASE_SERVICE_ROLE_KEY`; prieš kurdama patikrina, kad kviečiantis pats yra prisijungęs adminas);
- arba pirmam adminui, kai dar nėra nė vieno: `node scripts/bootstrap-admin.mjs [id] [slaptazodis]` (numatyta `marius` / `admin`).

Pagrindinis srautas (`items`/`pallets`/`shipments`/`catalog`) prisijungimo nereikalauja ir lieka pasiekiamas `anon` role.

## 2. Duomenų bazės struktūra (Supabase SQL schema)

Pilna, dabartinė schema yra `supabase/schema.sql` faile (naujam projektui pakanka paleisti tik jį). Esamai duomenų bazei, kuri kurta anksčiau, migracijas reikia paleisti chronologine tvarka — žr. failų sąrašą prie 1 skyriaus struktūros arba komentarus kiekvienos migracijos viršuje.

### Lentelė `items` (pavienės prekės / įrankiai)

| Stulpelis    | Tipas       | Paskirtis                                              |
|--------------|-------------|---------------------------------------------------------|
| `id`         | uuid (PK)   | Unikalus identifikatorius                               |
| `ian`        | text        | Skenuojamas/įvedamas kodas (pasikartojimai normalūs — tas pats modelis, keli vienetai) |
| `name`       | text        | Prekės pavadinimas (užpildoma automatiškai iš katalogo arba rankiniu būdu) |
| `category`   | text        | Kategorija (nebūtina)                                    |
| `quantity`   | integer     | Kiekis; skenuojant tą patį IAN toje pačioje paletėje, kiekis didinamas, o ne kuriamas naujas įrašas |
| `status`     | text        | `registered` → `checked` → `packed` → `shipped` / `rejected` |
| `notes`      | text        | Laisva pastaba                                            |
| `pallet_id`  | uuid (FK)   | Nuoroda į `pallets.id`, jei prekė priskirta paletei      |
| `created_at` | timestamptz | Sukūrimo laikas                                            |
| `updated_at` | timestamptz | Atnaujinama automatiškai per trigerį                       |

### Lentelė `catalog` (etaloninis IAN → pavadinimas/gamintojas/tipas katalogas)

| Stulpelis      | Tipas        | Paskirtis                                                     |
|----------------|--------------|-----------------------------------------------------------------|
| `id`           | uuid (PK)    | Unikalus identifikatorius                                       |
| `ian`          | text, unique | IAN kodas, ištrauktas iš originalaus Excel teksto                |
| `name`         | text         | Pavadinimas be skliaustelių dalies                                |
| `manufacturer` | text         | Gamintojas — naudojamas paskirties (destination) skaičiavimui     |
| `item_type`    | text         | Įrankio tipas — naudojamas paskirties (destination) skaičiavimui  |
| `raw_text`     | text         | Originalus pilnas tekstas iš Excel, neparsintas                    |
| `imported_at`  | timestamptz  | Importavimo laikas                                                |

Importuojama per `/katalogas` puslapį: vartotojas įkelia Excel/CSV, pasirenka stulpelį su tekstu (pvz. `"AURS Parkside PARS 7 A1-Service (356413)"`), sistema automatiškai ištraukia IAN skliausteliuose ir pavadinimą prieš juos, o gamintojo/tipo stulpeliai pasirenkami atskirai (nebūtini, antraštės „Gamintojas“/„Tipas“ atspėjamos automatiškai).

### Paskirtis (`destination`) — dinaminis paletžų/siuntų grupavimas

Kiekviena prekė, remiantis katalogo `manufacturer` + `item_type`, priskiriama paskirčiai, apskaičiuojamai front-end pusėje (`src/lib/destination.js`) kaip `"<gamintojas>_<tipas>"` (pvz. `grizzly_prietaisai`), arba `unclassified`, jei trūksta duomenų kataloge. Paskirčių kombinacijų gali daugėti be jokių schema pakeitimų — jas skaičiuoja bendra `pallet_number_counters` lentelė, o ne fiksuota reikšmių aibė.

### Lentelė `pallets` (paletės)

| Stulpelis     | Tipas       | Paskirtis                                                          |
|---------------|-------------|-----------------------------------------------------------------------|
| `id`          | uuid (PK)   | Unikalus identifikatorius                                             |
| `code`        | text        | Rodomas kodas, pvz. `PAL-3` — **nebe unikalus**, nes numeracija cikliškai atsistato po kiekvienos siuntos |
| `number`      | integer     | Sekantis paletės numeris savo paskirties viduje, priskiriamas automatiškai per trigerį |
| `destination` | text        | Apskaičiuota paskirtis (žr. aukščiau); vienoje paletėje visada tik viena paskirtis |
| `status`      | text        | `open` (skenuojama) → `closed` (uždaryta, laukia išvežimo) → `shipped` → `delivered` |
| `notes`       | text        | Pastaba                                                                |
| `shipment_id` | uuid (FK)   | Nuoroda į `shipments.id`, kai paletė priskirta siuntai                |
| `packed_at`   | timestamptz | Uždarymo (supakavimo) laikas, nustatomas automatiškai                  |
| `created_at`  | timestamptz | Sukūrimo laikas                                                        |
| `shipped_at`  | timestamptz | (nebūtina, istoriniam naudojimui)                                      |

Skenuojant prekę, sistema automatiškai suranda arba sukuria atvirą (`status='open'`) tos pačios paskirties paletę — nereikia rankiniu būdu pasirinkti paletės.

### Lentelė `shipments` (siuntos — transporto užsakymui)

| Stulpelis     | Tipas       | Paskirtis                                                    |
|---------------|-------------|-----------------------------------------------------------------|
| `id`          | uuid (PK)   | Unikalus identifikatorius                                       |
| `code`        | text, unique| Pvz. `SIUNTA-2026-08-06`, generuojamas front-end pusėje pagal datą |
| `destination` | text        | Viena siunta apima tik vienos paskirties paletes (užtikrina front-end) |
| `status`      | text        | `open` / `sent`                                                  |
| `sent_at`     | timestamptz | Išsiuntimo laikas                                                 |
| `created_at`  | timestamptz | Sukūrimo laikas                                                   |

Siuntos formuojamos **rankiniu būdu** `/paletes` puslapyje: vartotojas filtruoja pagal paskirtį, pažymi checkbox'ais laukiančias (uždarytas, dar nepriskirtas siuntai) paletes ir spaudžia „Pažymėti kaip išvežta“ — sukuriama nauja siunta ir pažymėtos paletės jai priskiriamos. Kai siunta pažymima kaip išsiųsta, tos paskirties palečių numeravimas atsistato atgal į 1.

### Lentelė `item_history` (nebūtina, bet naudinga)

Automatiškai registruoja kiekvieną `items.status` pasikeitimą (auditui / istorijai).

### Lentelė `pallet_number_counters` (vidinė)

Kiekvienos `destination` reikšmės dabartinis paletės numeris — naudojama automatiniam numeravimui ir jo atstatymui po siuntos išsiuntimo. Front-end tiesiogiai nesikreipia, ją valdo tik SECURITY DEFINER trigerio funkcijos.

### Administracinė funkcija `reset_test_data()`

Iškviečiama iš `/admin-reset` puslapio (RPC), reikalauja rankinio patvirtinimo žodžio ir prisijungusio administratoriaus (`migrate_admin_reset_require_admin.sql`). Negrįžtamai išvalo `items`, `pallets`, `shipments`, `item_history` bei `pallet_number_counters` — skirta tik testavimui.

### Priedų (spare parts) modulio lentelės

Nepriklausomos nuo pagrindinio srauto (`items`/`pallets`/`shipments`/`catalog`).

#### Lentelė `parts` (atsarginės dalys)

| Stulpelis           | Tipas       | Paskirtis                                                          |
|----------------------|-------------|----------------------------------------------------------------------|
| `id`                 | uuid (PK)   | Unikalus identifikatorius                                            |
| `location`           | integer     | Lokacija sandėlyje                                                    |
| `main_model`         | text        | Pagrindinis modelis                                                   |
| `part_code`          | text        | Detalės kodas (tekstas, nes formatas nevienodas — gali kartotis skirtingose lokacijose) |
| `name`               | text        | Pavadinimas                                                            |
| `quantity`           | integer     | Kiekis                                                                 |
| `min_quantity`       | integer     | Individualus mažo likučio slenkstis konkrečiam priedui; `NULL` = naudojama numatytoji reikšmė (3) |
| `stock_level`        | text (generated) | Apskaičiuojama DB pusėje iš `quantity`/`min_quantity`: `out` (≤0) / `low` (≤ slenkstis) / `ok`; leidžia `/priedai` filtrui filtruoti paprastu `.eq()` per PostgREST |
| `online_store`       | boolean     | Ar parduodama el. parduotuvėje                                        |
| `compatible_models`  | text        | Suderinami modeliai (laisvas tekstas)                                  |
| `notes`              | text        | Pastaba                                                                |
| `created_at`/`updated_at` | timestamptz | Sukūrimo/atnaujinimo laikas                                      |

Importuojama per `/priedai/importas` (Excel) — kadangi `part_code` nėra unikalus, importas visada veikia kaip `insert` per `import_parts(rows, clear_existing)` RPC funkciją (SECURITY DEFINER; `clear_existing=true` prieš importą išvalo esamus įrašus, reikalauja `delete` teisės).

#### Lentelė `profiles` (vienas įrašas kiekvienam prisijungusiam vartotojui)

| Stulpelis    | Tipas       | Paskirtis                                                     |
|--------------|-------------|-------------------------------------------------------------------|
| `id`         | uuid (PK)   | = `auth.users.id`                                                  |
| `username`   | text        | Išgaunamas automatiškai iš vidinio el. pašto (`<id>@parts.local`) per trigerį naujam `auth.users` įrašui |
| `is_admin`   | boolean     | Suteikia visas teises + prieigą prie `/priedai/vartotojai`, `/admin-reset` |
| `created_at` | timestamptz | Sukūrimo laikas                                                    |

#### Lentelė `user_permissions` (vartotojas × teisė)

| Stulpelis    | Tipas | Paskirtis                                                    |
|--------------|-------|-------------------------------------------------------------------|
| `user_id`    | uuid (FK → `profiles.id`) |                                               |
| `permission` | text  | Viena iš: `view`, `edit`, `delete`, `import` (CHECK apribojimas)   |
| `granted_at` | timestamptz | Suteikimo laikas                                             |

Atskira lentelė (ne stulpeliai `profiles` viduje), kad naujas teises būtų galima pridėti be schema pakeitimų. Teisių sąrašas įtvirtintas **trijose vietose**, kurias reikia atnaujinti kartu: `src/lib/permissions.js` (front-end), `api/create-user.js` (serverless funkcija) ir SQL `check` apribojimas (`migrate_add_parts_permissions.sql`) — DB negali importuoti JS failo.

Pagalbinės SQL funkcijos `is_admin(uid)` ir `has_permission(uid, perm)` (abi `SECURITY DEFINER`) naudojamos RLS taisyklėse `parts`/`profiles`/`user_permissions` lentelėms, kad būtų išvengta RLS rekursijos.

`parts` lentelės **peržiūra (select) yra vieša** (`to anon, authenticated`, žr. `migrate_parts_public_view.sql`) — `/priedai` sąrašą gali matyti bet kas be prisijungimo; insert/update/delete politikos nepakeistos, tebereikalauja atitinkamos teisės.

#### Lentelė `parts_writeoffs` (priedų nurašymų istorija)

| Stulpelis     | Tipas       | Paskirtis                                                              |
|---------------|-------------|--------------------------------------------------------------------------|
| `id`          | uuid (PK)   | Unikalus identifikatorius                                                |
| `part_id`     | uuid (FK)   | Nuoroda į `parts.id` (`on delete cascade`)                               |
| `user_id`     | uuid (FK)   | Nurašiusio vartotojo nuoroda į `profiles.id` (`on delete set null`)      |
| `quantity`    | integer     | Nurašytas kiekis (> 0)                                                   |
| `reason_type` | text        | Priežastis: `parduota` / `remontui` / `kita`                             |
| `price`       | numeric     | Kaina, jei `reason_type = 'parduota'`                                    |
| `rma`         | text        | RMA numeris, jei `reason_type = 'remontui'`                              |
| `reason`      | text        | Laisvas tekstas, jei `reason_type = 'kita'`                              |
| `created_at`  | timestamptz | Nurašymo laikas                                                          |
| `undone_at`   | timestamptz | Atšaukimo laikas, jei nurašymas atšauktas (`NULL` = aktyvus)              |
| `undone_by`   | uuid (FK)   | Atšaukusio vartotojo nuoroda į `profiles.id` (`on delete set null`)      |

Nurašoma per `writeoff_part(part_id, quantity, reason_type, price, rma, reason)` RPC funkciją (`SECURITY DEFINER`, reikalauja `delete` teisės — ta pati, kuri naudojama pavienio priedo trynimui) — vienu metu sumažina `parts.quantity` ir įrašo audito eilutę; patikrina, kad nurašomas kiekis neviršytų turimo likučio, ir kad pagal pasirinktą priežastį būtų užpildytas privalomas laukas (kaina/RMA/tekstas). Istorija matoma `/priedai/nurasymai` puslapyje (reikia `delete` teisės) ir prie kiekvieno priedo `/priedai` sąraše.

Nurašymą galima atšaukti per `undo_writeoff(writeoff_id)` RPC funkciją (`SECURITY DEFINER`, taip pat reikalauja `delete` teisės) — grąžina kiekį atgal į `parts.quantity` ir pažymi įrašą kaip atšauktą (`undone_at`/`undone_by`); pats įrašas netrinamas, kad liktų audito pėdsakas, ir atšaukti galima tik kartą. Atšaukimo mygtukas matomas tiek `/priedai/nurasymai`, tiek priedo išskleistoje istorijoje `/priedai` puslapyje.

### Prietaisų (įrangos) modulio lentelės

Nepriklausomos nuo pagrindinio srauto IR nuo priedų (`parts`) modulio — savo teisės (`device_permissions`). Peržiūra (SELECT) vieša, kaip ir visuose kituose moduliuose (žr. `migrate_devices_public_view.sql`) — redagavimas/trynimas/nurašymas/importas ir toliau reikalauja atitinkamos teisės. Duomenys normalizuoti į dvi lenteles, nes tas pats IAN gali pasikartoti keliose Excel eilutėse (skiriasi tik kiekis/lokacija).

#### Lentelė `devices` (unikalus prietaiso modelis)

| Stulpelis      | Tipas        | Paskirtis                                                     |
|-----------------|--------------|-----------------------------------------------------------------|
| `id`            | uuid (PK)    | Unikalus identifikatorius                                       |
| `ian`           | text, unique | IAN kodas — identifikuoja MODELĮ, ne fizinį vienetą               |
| `name`          | text         | Prietaiso pavadinimas                                             |
| `manufacturer`  | text         | Gamintojas (šiuo metu: Grizzly, Kompernass — laisvas tekstas)     |
| `notes`         | text         | Komentaras — VIENAS visam prietaisui (žr. `migrate_devices_notes.sql`), NE per lokaciją |
| `min_quantity`  | integer      | Individualus mažo likučio slenkstis BENDRAM kiekiui (žr. `migrate_add_device_min_quantity.sql`); `NULL` = numatyta reikšmė (3) |
| `created_at`/`updated_at` | timestamptz | Sukūrimo/atnaujinimo laikas                             |

#### Lentelė `device_stock` (kiekis konkrečioje lokacijoje)

| Stulpelis    | Tipas       | Paskirtis                                                          |
|--------------|-------------|-----------------------------------------------------------------------|
| `id`         | uuid (PK)   | Unikalus identifikatorius                                             |
| `device_id`  | uuid (FK)   | Nuoroda į `devices.id` (`on delete cascade`)                          |
| `location`   | text        | Lokacija sandėlyje; kartu su `device_id` — UNIQUE (pakartotinis importas atnaujina, ne dubliuoja) |
| `quantity`   | integer     | Kiekis toje lokacijoje                                                |
| `notes`      | text        | NEBENAUDOJAMAS front-end pusėje nuo `migrate_devices_notes.sql` — komentaras dabar `devices.notes` |
| `created_at`/`updated_at` | timestamptz | Sukūrimo/atnaujinimo laikas                                |

Bendram kiekiui per visas lokacijas naudojamas `device_totals` VIEW (grupuoja `device_stock` pagal `device_id`, sumuoja `quantity`) su **`security_invoker = true`** — BE ŠIOS PARINKTIES view vykdytų RLS view savininko (Supabase atveju „postgres“, kuris turi BYPASSRLS) teisėmis ir visiškai apeitų `devices`/`device_stock` RLS, atskleisdamas visų prietaisų duomenis bet kuriam prisijungusiam vartotojui nepriklausomai nuo `view` teisės. Su `security_invoker = true` view vykdomas UŽKLAUSĖJO teisėmis, todėl realiai paveldi tų pačių lentelių RLS. Šis pats VIEW taip pat skaičiuoja **`stock_level`** (`out`/`low`/`ok`, pagal `total_quantity` vs `min_quantity` arba numatytą 3) — ta pati logika, kaip `parts.stock_level`, bet SKAIČIUOJAMA VIEW viduje (ne `generated always as` stulpelyje pačioje `devices` lentelėje), nes kiekis yra kitoje (`device_stock`) lentelėje. `/prietaisai` sąrašo eilutės nudažomos pagal šią būseną (raudona = baigėsi, gintarinė = mažas likutis) — ta pati vizualinė kalba, kaip `/priedai`.

Importuojama per `import_devices(rows, p_clear_existing)` RPC funkciją (`SECURITY DEFINER`, reikalauja `import` teisės): kiekvienai eilutei upsert į `devices` pagal `ian` (pavadinimas/gamintojas/komentaras atnaujinami naujausia reikšme, bet TIK jei Excel eilutėje laukas neTUŠČIAS — `coalesce(excluded.x, devices.x)` — kad pakartotinis importas su tuščiu langeliu neišvalytų jau turimos reikšmės), tada upsert į `device_stock` pagal `(device_id, location)` (kiekis perrašomas). Eilutės be IAN praleidžiamos. `p_clear_existing=true` papildomai reikalauja `delete` teisės.

#### Lentelė `device_permissions` (vartotojas × teisė)

Tos pačios keturios teisės kaip `parts` modulyje (`view`, `edit`, `delete`, `import`), bet **atskira** lentelė nuo `user_permissions` — priskyrimas vienam moduliui neturi jokios įtakos kitam. Naudoja bendrą `is_admin()` kaip super-adminą. `view` teisė NEBEriboja SELECT (nuo `migrate_devices_public_view.sql` — kaip ir `parts`/`pallets`, peržiūra vieša); ji lieka `DEVICE_PERMISSIONS` sąraše dėl suderinamumo ir naudojama tik kaip papildomas app-lygio vartų raktas `/statistika` prietaisų skirtukui (žr. `Stats.jsx`).

#### Lentelė `device_writeoffs` (prietaisų nurašymų istorija)

| Stulpelis     | Tipas       | Paskirtis                                                              |
|---------------|-------------|--------------------------------------------------------------------------|
| `id`          | uuid (PK)   | Unikalus identifikatorius                                                |
| `device_id`   | uuid (FK)   | Nuoroda į `devices.id` (`on delete SET NULL`, ne cascade — žr. paaiškinimą žemiau) |
| `device_name` | text        | Prietaiso pavadinimas — LAISVAS TEKSTAS (kopija nurašymo metu, NE FK), kad išliktų net ištrynus patį prietaisą |
| `device_ian`  | text        | Prietaiso IAN — ta pati logika kaip `device_name`                        |
| `location`    | text        | Lokacija, iš kurios nurašyta — LAISVAS TEKSTAS (kopija nurašymo metu, NE FK į `device_stock`), kad audito įrašas išliktų net ištrynus tos lokacijos likutį |
| `user_id`     | uuid (FK)   | Nurašiusio vartotojo nuoroda į `profiles.id` (`on delete set null`)      |
| `quantity`    | integer     | Nurašytas kiekis (> 0)                                                   |
| `reason_type` | text        | Priežastis: `parduota` / `remontui` / `garantija` / `kita`               |
| `price`       | numeric     | Kaina, jei `reason_type = 'parduota'`                                    |
| `rma`         | text        | RMA numeris, jei `reason_type = 'remontui'`                              |
| `reason`      | text        | Laisvas tekstas — PRIVALOMAS jei `reason_type = 'kita'`, NEBŪTINAS jei `reason_type = 'garantija'` |
| `created_at`  | timestamptz | Nurašymo laikas                                                          |
| `undone_at`   | timestamptz | Atšaukimo laikas, jei nurašymas atšauktas (`NULL` = aktyvus)              |
| `undone_by`   | uuid (FK)   | Atšaukusio vartotojo nuoroda į `profiles.id` (`on delete set null`)      |

Skirtingai nuo `parts_writeoffs` (kur kiekis yra vienas `part.quantity` laukas), prietaiso kiekis yra PER LOKACIJĄ (`device_stock`), todėl nurašoma per `writeoff_device(device_id, location, quantity, reason_type, price, rma, reason)` RPC funkciją (`SECURITY DEFINER`, reikalauja `delete` teisės) — sumažina KONKREČIOS lokacijos `device_stock.quantity`, nuskaito `devices.name`/`ian` ir įrašo audito eilutę kartu su jais (denormalizuoti); ta pati validacija kaip `writeoff_part` (likutis, privalomas laukas pagal priežastį), IŠSKYRUS `garantija` — jai papildomas laukas nereikalingas (žr. `migrate_add_device_pickups.sql`). Atšaukiama per `undo_device_writeoff(writeoff_id)` — grąžina kiekį atgal į `device_stock` (jei ta lokacijos eilutė tarpu buvo ištrinta, sukuriama iš naujo per upsert) ir žymi `undone_at`/`undone_by`; jei pats prietaisas tarpu ištrintas (`device_id` jau `NULL`), atšaukti nebegalima — funkcija apie tai aiškiai praneša. Pats įrašas netrinamas, atšaukti galima tik kartą. Istorija matoma `/prietaisai/nurasymai` puslapyje ir prie kiekvieno prietaiso `/prietaisai` sąraše.

#### Lentelė `device_pickups` (atsinešimų sąrašas — garantinis servisas)

Garantinio serviso srautui: klientas atsiunčia sugedusį prietaisą, reikia rasti IR atsinešti iš sandėlio TO PATIES PAVADINIMO pakaitinį (IAN dažniausiai skiriasi — tai kitas fizinis vienetas). Šis sąrašas pakeičia buvusį rankinį sekimą Google Sheets ("ką atsinešti") IR Excel (nurašymo žurnalas).

| Stulpelis         | Tipas       | Paskirtis                                                          |
|--------------------|-------------|-------------------------------------------------------------------|
| `id`               | uuid (PK)   | Unikalus identifikatorius                                          |
| `device_id`        | uuid (FK)   | Nuoroda į `devices.id` (`on delete cascade`)                       |
| `quantity`         | integer     | Reikalingas kiekis (> 0)                                           |
| `note`             | text        | Nebūtina pastaba (pvz. kliento grąžinto prietaiso IAN ar užsakymo Nr.) |
| `user_id`          | uuid (FK)   | Punktą pridėjusio vartotojo nuoroda (`on delete set null`)         |
| `created_at`       | timestamptz | Pridėjimo laikas                                                    |
| `picked_at`        | timestamptz | Paėmimo laikas (`NULL` = dar laukia) — ta pati "timestamptz kaip būsena" logika, kaip `packed_at`/`undone_at` kitur schemoje |
| `picked_by`        | uuid (FK)   | Paėmusio vartotojo nuoroda (`on delete set null`)                  |
| `picked_location`  | text        | Lokacija, iš kurios faktiškai paimta                                |
| `writeoff_id`      | uuid (FK)   | Nuoroda į `device_writeoffs.id` (`on delete set null`) — `NULL` = dar nenurašyta, užpildyta = nurašyta |

TRYS atskiri žingsniai/būsenos — SĄMONINGAI atskirti, nes fizinis daikto paėmimas iš lentynos ir jo nurašymas iš apskaitos NĖRA tas pats momentas:

1. **Laukia** (`picked_at is null`) — punktą prideda/trina tiesiogiai per `insert`/`delete` (RLS, reikalauja `edit` teisės); trinti galima TIK šioje būsenoje.
2. **Paimta** (`picked_at is not null`, `writeoff_id is null`) — žymima per `mark_device_picked(pickup_id, location)` RPC (`SECURITY DEFINER`, reikalauja `edit` teisės; `picked_by`/`picked_at` nustatomi SERVERIO pusėje, ne kliento siunčiamais laukais). `device_stock` DAR NEKEIČIAMAS. Kol punktas dar NENURAŠYTAS, jį galima grąžinti atgal į „Laukia" per `unpick_device_pickup(pickup_id)` RPC (`SECURITY DEFINER`, reikalauja `edit` teisės; mygtukas „Atgal" prie punkto) — išvalo `picked_at`/`picked_by`/`picked_location`, naudinga jei paspausta per klaidą arba pasirinkta ne ta lokacija.
3. **Nurašyta** (`writeoff_id is not null`) — TIK dabar, paspaudus „Nurašyti", per `finalize_device_pickup(pickup_id)` RPC (`SECURITY DEFINER`, reikalauja `delete` teisės) — ji naudoja jau užfiksuotą lokaciją/kiekį/pastabą ir iškviečia `writeoff_device(..., reason_type='garantija', reason=note)`, kuris dabar GRĄŽINA sukurto įrašo `id` (susiejamas su `writeoff_id`). Jei toks nurašymas atšaukiamas (`undo_device_writeoff`), punktas automatiškai grįžta į „Paimta" būseną (`writeoff_id` išvalomas) — iš čia jį irgi galima grąžinti į „Laukia" per `unpick_device_pickup`.

Sąrašas matomas `/prietaisai/atsinesimai` puslapyje.

**Kodėl `device_id` yra `on delete set null`, o ne `cascade`:** priešingai nei pirminiame projekte, ištrynus patį prietaisą (`/prietaisai` → „Ištrinti prietaisą“), jo nurašymų audito istorija TURI IŠLIKTI (ta pati filosofija, kaip `parts_writeoffs` niekada netrina savo įrašų) — `device_name`/`device_ian` denormalizavimas tai užtikrina. Tas pats denormalizavimas taip pat leidžia `/prietaisai/nurasymai` puslapiui veikti vien su `delete` teise, be JOIN į `devices` (kuriam RLS reikalautų atskiros `view` teisės).

### Kaip įdiegti

1. Supabase projekto skydelyje eikite į **SQL Editor**.
2. **Naujam projektui** — įkelkite ir paleiskite visą `supabase/schema.sql` failo turinį (jis apima ir katalogą, siuntas, dinaminę paskirtį, priedų modulį su prisijungimu ir teisėmis).
3. **Esamam projektui, kuris kurtas anksčiau** — paleiskite trūkstamas `migrate_*.sql` migracijas chronologine tvarka (žr. failo pavadinimą ir komentarą jo viršuje; pilnas sąrašas — 1 skyriaus struktūroje).
4. Tai sukurs lenteles, indeksus, RLS (Row Level Security) taisykles ir įjungs Realtime `items`/`pallets`/`shipments`/`parts` lentelėms.
5. Sukurkite pirmą admin vartotoją priedų moduliui: `node scripts/bootstrap-admin.mjs` (žr. 3 skyrių dėl `SUPABASE_SERVICE_ROLE_KEY`).

> **Apie RLS:** `items`, `pallets`, `catalog` numatytos prieigai per **authenticated** vartotojus. `shipments` leidžia prieigą ir `anon`, ir `authenticated` (nes siuntų formavimas veikia be prisijungimo ekrano). `parts` IR `devices`/`device_stock` **peržiūra (select)** vieša `anon` ir `authenticated` (žr. `migrate_parts_public_view.sql` / `migrate_devices_public_view.sql`); jų insert/update/delete bei `parts_writeoffs`/`device_writeoffs`/`profiles`/`user_permissions`/`device_permissions` prieinamos tik `authenticated` vartotojams, papildomai apribotos pagal konkrečią teisę (`has_permission`/`has_device_permission`). Jei pagrindinį srautą naudosite tik vidiniame tinkle be prisijungimo ekrano, pakeiskite likusias `to authenticated` į `to anon` schema faile — bet tuomet svarbu, kad programa nebūtų pasiekiama iš viešo interneto be papildomos apsaugos (pvz. VPN, IP apribojimas).

## 3. Sujungimas su Supabase (.env kintamieji)

1. Supabase Dashboard → **Project Settings → API** rasite:
   - `Project URL`
   - `anon public` raktą
   - `service_role` **slaptą** raktą (reikalingas tik priedų modulio vartotojų kūrimui)
2. Projekto šaknyje nukopijuokite `.env.example` į `.env`:

   ```bash
   cp .env.example .env
   ```

3. Įrašykite savo reikšmes:

   ```
   VITE_SUPABASE_URL=https://jusu-projektas.supabase.co
   VITE_SUPABASE_ANON_KEY=jusu-anon-public-raktas
   SUPABASE_SERVICE_ROLE_KEY=jusu-service-role-slaptas-raktas
   ```

   `SUPABASE_SERVICE_ROLE_KEY` **NETURI** `VITE_` priešdėlio (kad Vite jo neįtrauktų į naršyklės bundle'ą) — naudojamas tik serverio pusėje (`api/create-user.js`, `scripts/bootstrap-admin.mjs`). Niekada jo nekomituoti į Git.

   `.env` failas jau įtrauktas į `.gitignore`, todėl jis nebus nusiųstas į Git.

## 4. Paleidimas lokaliai (localhost)

Reikalinga: **Node.js 18+** (rekomenduojama 20+).

```bash
# 1. Įeikite į projekto katalogą
cd warehouse-app

# 2. Įdiekite priklausomybes
npm install

# 3. Sukurkite .env failą (jei dar nepadarėte — žr. 3 skyrių)
cp .env.example .env

# 4. Paleiskite dev serverį
npm run dev
```

Aplikacija bus pasiekiama adresu **http://localhost:5173**.

Norint pasiekti iš kito įrenginio tame pačiame tinkle (pvz. planšetės skenavimui sandėlyje), `vite.config.js` jau turi `host: true` — atidarykite `http://JUSU-KOMPIUTERIO-IP:5173` iš planšetės naršyklės.

### Produkcinis build'as (jei norėsite talpinti, pvz. Vercel/Netlify)

```bash
npm run build      # sukuria "dist" katalogą
npm run preview    # patikrinti build'ą lokaliai
```

## 5. Kaip veikia pagrindiniai srautai

### Palečių išvežimo srautas (be prisijungimo)

- **Skenavimas (`/`)** — didelis mono šrifto laukas priima skenerio arba rankinę įvestį. Skeneris veikia kaip klaviatūra + Enter, todėl papildomos integracijos nereikia. Nuskenavus IAN kodą, sistema jį ieško `catalog` lentelėje, automatiškai užpildo pavadinimą ir apskaičiuoja paskirtį (gamintojas + tipas). Prekė automatiškai priskiriama atviros tos paskirties paletės (jei tokios nėra — sukuriama nauja), o skenuojant tą patį IAN toje pačioje paletėje pakartotinai — didinamas `quantity`, o ne kuriamas naujas įrašas. Puslapyje matomos visos šiuo metu atviros paletės su galimybe pažymėti „Išvežta“ (uždaryti).
- **Paletės (`/paletes`)** — rodomos uždarytos, bet siuntai dar nepriskirtos paletės, filtruojamos pagal paskirtį; vartotojas pažymi checkbox'ais kelias paletes ir vienu veiksmu pažymi jas kaip išvežtas (sukuriama nauja siunta) arba atsisiunčia Excel sąrašą pagal paletę/pavadinimą/kiekį/IAN kodus. Nuoroda veda į `/siuntos` — jau išsiųstų siuntų istoriją.
- **Paletės detalė (`/paletes/:id`)** — matomas visas paletės turinys (IAN, pavadinimas, kiekis, būsena), galima pašalinti prekę iš paletės arba keisti pačios paletės būseną (formuojama → uždaryta → išsiųsta → pristatyta).
- **Siuntos (`/siuntos`)** — jau išsiųstų siuntų sąrašas (paletžų skaičius, vnt. suma), filtras pagal paskirtį, IAN paieška tarp visų kada nors išvežtų prekių (nukelia tiesiai į atitinkamos siuntos puslapį su iš anksto įvesta paieška).
- **Siuntos detalė (`/siuntos/:id`)** — siuntos paletės su turiniu (išskleidžiama), Excel eksportas, palečių etikečių spausdinimas.
- **Katalogo importas (`/katalogas`, admin)** — Excel/CSV įkėlimas, stulpelio su „Pavadinimas (IAN)“ tekstu pasirinkimas (IAN automatiškai ištraukiamas iš skliaustelių), nebūtini gamintojo/tipo stulpeliai paskirties skaičiavimui. Importas veikia partijomis (upsert pagal IAN), rodo progresą ir suvestinę (nauji/atnaujinti/nepavykę).
- **Administravimas (`/admin-reset`, reikia prisijungimo + admin teisės)** — testavimo duomenų (prekės, paletės, siuntos, istorija, numeravimo skaitliukai) negrįžtamas išvalymas, apsaugotas patvirtinimo žodžiu.

### Priedų (spare parts) modulis

- **Prisijungimas** — nėra atskiro `/login` maršruto: prisijungimo forma (`InlineLoginForm`) rodoma tiesiog viršutinėje juostoje (bet kuriame puslapyje) arba apsaugoto puslapio viduje, kai reikia konkrečios teisės. ID (ne el. paštas) + slaptažodis; sėkmingai prisijungus, puslapis persirenderina su prisijungusio turiniu vietoje peradresavimo.
- **Priedai (`/priedai`, peržiūra vieša visiems be prisijungimo)** — priedų sąrašas su paieška, filtrais (lokacija, mažas/nulinis likutis pagal `stock_level`), puslapiavimu; su „edit“ teise galima keisti kiekį/pastabas/individualų min. likučio slenkstį (`min_quantity`)/laukus ar pridėti naują įrašą tiesiogiai lentelėje, su „delete“ — trinti arba nurašyti priedą (kiekio dalį, nurodant priežastį: parduota/remontui/kita — įrašoma į `parts_writeoffs`) bei atšaukti bet kurį savo priedo aktyvų nurašymą tiesiog išskleistoje istorijoje; Excel eksportas.
- **Priedų importas (`/priedai/importas`, reikia „import“ teisės)** — Excel (.xlsx) arba CSV įkėlimas (`readSpreadsheet.js`), stulpelių atspėjimas (`excelHeaders.js`), importas per `import_parts` RPC (visada `insert`, nes `part_code` nėra unikalus); pasirinktinai prieš importą išvalyti esamus įrašus (reikia papildomai „delete“ teisės).
- **Nurašymai (`/priedai/nurasymai`, reikia „delete“ teisės)** — visų priedų nurašymų istorija (data, priedas, kiekis, priežastis, detalė, kas nurašė, būsena), paieška pagal priedo pavadinimą/kodą, filtras pagal priežastį, atšauktų nurašymų atšaukimas (`undo_writeoff` RPC — grąžina kiekį, žymi `undone_at`/`undone_by`, netrina audito įrašo), Excel eksportas (su „Būsena“ stulpeliu).
- **Vartotojai (`/priedai/vartotojai`, reikia „admin“ teisės arba `is_admin`)** — naujo vartotojo (ID + slaptažodis) kūrimas per `api/create-user.js`, esamų vartotojų teisių (view/edit/delete/import) valdymas VISUOSE trijuose moduliuose (priedai/paletės/prietaisai, nepriklausomos viena nuo kitos) ir admin žymos perjungimas.

### Prietaisų (įrangos) modulis

Nepriklausomas nuo priedų (`parts`) modulio — savo teisės (`device_permissions`), naudoja tą patį prisijungimą (bendras `profiles`/ID+slaptažodis). **Peržiūra vieša** (kaip ir `/priedai`) — nuoroda navigacijos meniu rodoma visada, nepriklausomai nuo prisijungimo.

- **Prietaisai (`/prietaisai`, peržiūra vieša visiems be prisijungimo)** — prietaisų (modelių, unikalių pagal IAN) sąrašas su paieška (pavadinimas/IAN/gamintojas), filtru pagal gamintoją IR filtru pagal likutį (Visi/Mažas likutis/Tik baigęsis — kadangi `devices` lentelė pati stock_level neturi, jis paskaičiuojamas per `device_totals`, tad filtras veikia dviem žingsniais: pirma surandami atitinkantys `id`, tada pagrindinė užklausa apribojama `.in()`); pagrindinėje lentelėje rodomas tik bendras kiekis (BE gamintojo stulpelio), lokacijos IR gamintojas matomi TIK išskleidus eilutę (paprastas tekstas „Lokacija X (Y vnt.)“ kiekvienai, be redagavimo). Eilutės nudažomos pagal `stock_level` (raudona = baigėsi, gintarinė = mažas likutis pagal `min_quantity` arba numatytą 3) — ta pati vizualinė kalba, kaip `/priedai`. Komentaras priklauso VISAM prietaisui (ne pavienei lokacijai) — su „edit“ teise redaguojamas kaip vienas laukas po lokacijų sąrašu; taip pat redaguoti paties prietaiso pavadinimą/IAN/gamintoją/min. likutį arba sukurti naują prietaisą. Su „delete“ teise — trys veiksmų mygtukai tokio pat dizaino kaip `/priedai`: **Redaguoti**, **Nurašyti** (modalas su lokacijos pasirinkimu, jei prietaisas turi kelias — nurašo dalį pasirinktos lokacijos kiekio, nurodant priežastį: parduota/remontui/garantija/kita — įrašoma į `device_writeoffs`, atšaukiama tiesiog išskleistoje istorijoje) ir **Ištrinti prietaisą** (su visais jo likučiais); pavienė lokacijos eilutė atskiro trynimo mygtuko nebeturi — likutis mažinamas tik per nurašymą arba viso prietaiso trynimą. Su „edit“ teise — TIESIOG PAGRINDINĖJE lentelės eilutėje (be išskleidimo) mažas mygtukas **„Atsinešti"**, atidarantis langelį (kiekis + nebūtina pastaba) ir pridedantis punktą į garantinio serviso atsinešimų sąrašą (`device_pickups`, žr. žemiau) — be poreikio dar kartą rinktis prietaisą, nes jis jau žinomas iš eilutės. Excel eksportas (kiekviena lokacija — sava eilutė, komentaras kartojasi kiekvienoje).
- **Prietaisų importas (`/prietaisai/importas`, reikia „import“ teisės)** — Excel (.xlsx) arba CSV įkėlimas, stulpelių atspėjimas (Prietaisas/IAN/Kiekis/Lokacija/Komentaras/Gamintojas), importas per `import_devices` RPC — upsert pagal IAN į `devices` (pavadinimas/gamintojas/komentaras atnaujinami naujausia reikšme), tada upsert pagal (device_id, lokacija) į `device_stock` (kiekis perrašomas, ne dubliuojamas); pasirinktinai prieš importą išvalyti esamus duomenis (reikia papildomai „delete“ teisės).
- **Prietaisų nurašymai (`/prietaisai/nurasymai`, reikia „delete“ teisės)** — visų prietaisų nurašymų istorija (data, prietaisas, IAN, lokacija, kiekis, priežastis, detalė, kas nurašė, būsena), paieška pagal prietaiso pavadinimą/IAN, filtras pagal priežastį, aktyvių nurašymų atšaukimas (`undo_device_writeoff` RPC), Excel eksportas.
- **Atsinešimai (`/prietaisai/atsinesimai`, reikia „edit“ teisės; „Nurašyti“ — papildomai „delete“)** — garantinio serviso „ką atsinešti iš sandėlio" sąrašo peržiūra ir valdymas, dvi dalys: **Laukia** (punktai PRIDEDAMI iš `/prietaisai` sąrašo, ne šiame puslapyje — čia tik matomi: prietaisas, gamintojas, esamos lokacijos su kiekiais sandėlyje (padeda greitai susirasti), reikalingas kiekis, pastaba, data; filtras pagal gamintoją; galima ištrinti tik dar nepaimtą punktą) ir **Paimta** (paskutiniai 50, su Būsenos stulpeliu). Pažymėjus „Paimta" — pasirenki lokaciją, iš kurios faktiškai paėmei (`mark_device_picked` RPC) — TAI DAR NEKEIČIA `device_stock`; jei paspaudei per klaidą, mygtukas **„Atgal"** grąžina punktą į „Laukia" (`unpick_device_pickup` RPC), kol jis dar nenurašytas. Kiekis sumažinamas ir `device_writeoffs` audito įrašas (priežastis „Garantinis pakeitimas") sukuriamas TIK paspaudus atskirą mygtuką **„Nurašyti"** prie to paties punkto (`finalize_device_pickup` RPC) — du sąmoningai atskirti žingsniai, nes fizinis paėmimas ir apskaitos nurašymas realybėje įvyksta skirtingu metu. Virš sąrašo — **„Importas iš vidinės sistemos (PDF)"**: įkėlus vidinės (be API) sistemos „Internal transfer" PDF pažymą (nuskaitoma naršyklėje per `pdfjs-dist`, lazy-load'inama tik pareikalavus — žr. `src/lib/readTransferPdf.js`), kiekviena eilutė (pavadinimas, IAN, kiekis) susiejama su atitinkamu vienareikšmiu „Paimta, dar nenurašyta" punktu pagal IAN + kiekį; paspaudus „Vykdyti", automatiškai nurašomi TIK vienareikšmiai atitikmenys — visa kita (IAN nerastas / nerastas atitinkamas punktas / kiekis nesutampa / keli galimi punktai) tik pažymima peržiūrai, niekas automatiškai nekuriama ar spėjama. Pakeičia buvusį rankinį Google Sheets ("ką atsinešti") + Excel (nurašymo žurnalas) sekimą.

### Statistika (bendra visam projektui)

**Vienas** puslapis (`/statistika`, `src/pages/Stats.jsx`) abiem sandėlio moduliams — NE atskiras kiekvienam. Meniu nuoroda rodoma atskira grupe apačioje, prieš „Admin“, jei vartotojas turi bent vieno modulio „delete“ teisę (priedų `user_permissions` arba prietaisų `device_permissions`).

- Viršuje — mygtukų pora **Priedai** / **Prietaisai**, perjungianti, kurio modulio statistika rodoma; jei vartotojas turi teisę tik į vieną modulį, perjungiklis nerodomas, iškart matomas tas vienas. Jei neturi nė vieno — rodomas „Neturite teisės“ pranešimas (kaip `RequirePermission`).
- Bendras „Laikotarpis“ filtras (30 d./šie metai/visada) galioja abiem moduliams vienodai.
- **Priedų** vaizdas — nepakitęs nuo ankstesnio `/priedai/statistika`: stat kortelės (priedų įrašai, vienetai iš viso, mažo likučio/pasibaigę pagal `stock_level`), nurašymų suvestinė (iš viso nurašyta, parduota €, remontui, kita) iš `parts_writeoffs`, TOP 5 dažniausiai nurašomų priedų.
- **Prietaisų** vaizdas — analogiška struktūra, dabar IR su `stock_level`/`min_quantity` sąvoka (žr. `migrate_add_device_min_quantity.sql`): stat kortelės (prietaisų modelių, vienetų iš viso, mažo likučio, be likučio — abi paskutinės pagal `device_totals.stock_level`, lokacijų iš viso), ta pati nurašymų suvestinė iš `device_writeoffs` PAPILDYTA penkta plytele „Garantiniai pakeitimai" (`reason_type='garantija'`, žr. `/prietaisai/atsinesimai`), TOP 5 dažniausiai nurašomų prietaisų.
- Abu vaizdai skaičiuoja tik iš AKTYVIŲ (neatšauktų) nurašymų ir atsinaujina realiu laiku per Supabase Realtime, kaip ir anksčiau.
- **Plytelės — paspaudžiamos nuorodos, ne tik skaičiai.** Ten, kur prasminga (mažo likučio/pasibaigę, nurašymo priežastys, TOP 5 įrašai), plytelė nuveda į atitinkamą sąrašo puslapį su JAU PRITAIKYTU filtru per URL parametrus: `?likutis=low|out` (`/priedai`, `/prietaisai`), `?priezastis=<tipas>` (`/priedai/nurasymai`, `/prietaisai/nurasymai`), `?q=<pavadinimas>` (TOP 5 → paieška sąraše). Paskirties puslapiai šiuos parametrus perskaito TIK vieną kartą pradiniam būsenos užpildymui (`useSearchParams`, lazy `useState` init) — toliau filtrai valdomi įprastai per UI, URL vėliau nesinchronizuojamas atgal. Bendros sumos be prasmingo filtro (pvz. „Vienetų iš viso", „Lokacijų iš viso") lieka paprastos informacinės kortelės, ne nuorodos.

## 6. Tolimesni žingsniai (pasiūlymai)

- Priedų modulyje jau yra Supabase Auth + teisėmis pagrįstas RLS (žr. 2 skyrių) — apsvarstyti tą patį pagrindiniam sandėlio srautui (`items`/`pallets`/`shipments`), pereinant nuo `anon` prie `authenticated` RLS taisyklių, jei prireiks atskirti darbuotojus.
- Naudoti realų barkodų skenerį (USB/Bluetooth HID skeneriai veikia be papildomo kodo, nes emuliuoja klaviatūrą).
- Pridėti `item_history` peržiūros ekraną prekės detalėje, jei prireiks pilnos audito istorijos.
- Apsvarstyti nuorodą į `/katalogas` navigacijoje su rolėmis pagrįsta prieiga, vietoj slapto tiesioginio adreso (kiti administraciniai puslapiai jau apsaugoti `RequirePermission`).
