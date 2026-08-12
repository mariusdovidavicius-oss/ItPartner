# Sandėlio valdymo sistema (IAN skenavimas, paletės, siuntos) + priedų sandėlis

Vidinė valdymo sistema, pakeičianti Excel/Google Sheets lentelę. Du domenai vienoje aplikacijoje:

1. **Pagrindinis sandėlio srautas** — prekių registravimas pagal IAN kodą, realaus laiko lentelė, automatinis paskirstymas į paletes pagal gamintoją/tipą, palečių grupavimas į siuntas ir būsenų valdymas, paieška ir redagavimas. Šis srautas veikia be prisijungimo (`anon` prieiga).
2. **Priedų (atsarginių dalių) sandėlio modulis** (`/priedai`) — atskira, nepriklausoma prekių apskaita su Supabase Auth prisijungimu ir granuliuotomis vartotojų teisėmis (peržiūra/redagavimas/trynimas/importas/admin).

**Stack:** Vite + React + React Router + Tailwind CSS + Supabase (PostgreSQL, Auth, Realtime) + SheetJS (xlsx) Excel eksportui/importui. Vercel serverless funkcija (`api/create-user.js`) vartotojų kūrimui.

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
│       fix_import_parts_delete_permission, admin_reset_require_admin
│       (žr. 2 skyrių)
└── src/
    ├── main.jsx
    ├── App.jsx                    ← maršrutai (routes)
    ├── index.css                   ← Tailwind + bendri stiliai
    ├── lib/
    │   ├── supabaseClient.js       ← Supabase klientas
    │   ├── AuthProvider.jsx        ← prisijungimo kontekstas (Supabase Auth sesija, profilis, teisės)
    │   ├── authConstants.js        ← ID → vidinis el. paštas (`<id>@parts.local`) konvertavimas
    │   ├── permissions.js          ← priedų modulio teisių sąrašas (view/edit/delete/import)
    │   ├── constants.js            ← būsenų sąrašai (ITEM/PALLET/SHIPMENT) ir spalvos
    │   ├── destination.js          ← "paskirties" (destination) skaičiavimas iš gamintojo+tipo
    │   ├── excelHeaders.js         ← Excel stulpelių antraščių atspėjimas importuojant
    │   ├── exportExcel.js          ← Excel eksportas (paletės, siuntos, priedai)
    │   └── printLabel.js           ← paletės etikečių spausdinimas
    ├── components/
    │   ├── Layout.jsx               ← šoninė/apatinė navigacija (grupuota pagal modulį)
    │   ├── RequirePermission.jsx    ← route guard: reikalauja prisijungimo, o su `permission` — ir konkrečios teisės
    │   ├── StatusBadge.jsx
    │   └── DestinationBadge.jsx
    └── pages/
        ├── Login.jsx                 ← "/login" — prisijungimas ID + slaptažodžiu
        ├── ScanEntry.jsx             ← "/" — IAN skenavimas/registravimas, atviros paletės
        ├── Pallets.jsx               ← "/paletes" — laukiančios paletės, rankinis siuntų formavimas, Excel eksportas
        ├── PalletDetail.jsx          ← "/paletes/:id" — paletės turinys, būsenos keitimas, prekės pašalinimas
        ├── ShipmentsList.jsx         ← "/siuntos" — jau išsiųstų siuntų sąrašas + IAN paieška tarp išvežtų prekių
        ├── ShipmentDetail.jsx        ← "/siuntos/:id" — siuntos turinys (paletės, prekės), Excel eksportas, etikečių spausdinimas
        ├── Parts.jsx                 ← "/priedai" — priedų sąrašas, paieška, redagavimas, Excel eksportas (reikia "view" teisės)
        ├── PartsImport.jsx           ← "/priedai/importas" — priedų importas iš Excel (reikia "import" teisės)
        ├── PartsUsers.jsx            ← "/priedai/vartotojai" — vartotojų kūrimas ir teisių valdymas (reikia "admin" teisės)
        ├── CatalogImport.jsx         ← "/katalogas" — admin: katalogo (IAN → pavadinimas/gamintojas/tipas) importas iš Excel/CSV
        └── AdminReset.jsx            ← "/admin-reset" — admin: visų testavimo duomenų išvalymas (reikia "admin" teisės)
```

Puslapis `/katalogas` yra administracinis — pasiekiamas tik tiesioginiu adresu, be nuorodos navigacijos meniu. `/admin-reset`, `/priedai/*` papildomai apsaugoti `RequirePermission` komponentu (žr. žemiau) — be prisijungimo arba be reikiamos teisės peradresuoja į `/login` arba parodo pranešimą apie teisių trūkumą.

### Priedų modulio prisijungimas ir teisės

Vartotojai neturi el. pašto — jungiasi trumpu **ID** (pvz. `marius`), kuris front-end pusėje paverčiamas į vidinį `<id>@parts.local` formatą Supabase Auth reikmėms (`src/lib/authConstants.js`). Teisės (`view`/`edit`/`delete`/`import`) saugomos `user_permissions` lentelėje po vieną eilutę kiekvienai; `is_admin` (lentelėje `profiles`) automatiškai suteikia visas teises ir prieigą prie `/priedai/vartotojai`, `/admin-reset`. Naujus vartotojus kuria tik administratorius:

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

### Kaip įdiegti

1. Supabase projekto skydelyje eikite į **SQL Editor**.
2. **Naujam projektui** — įkelkite ir paleiskite visą `supabase/schema.sql` failo turinį (jis apima ir katalogą, siuntas, dinaminę paskirtį, priedų modulį su prisijungimu ir teisėmis).
3. **Esamam projektui, kuris kurtas anksčiau** — paleiskite trūkstamas `migrate_*.sql` migracijas chronologine tvarka (žr. failo pavadinimą ir komentarą jo viršuje; pilnas sąrašas — 1 skyriaus struktūroje).
4. Tai sukurs lenteles, indeksus, RLS (Row Level Security) taisykles ir įjungs Realtime `items`/`pallets`/`shipments`/`parts` lentelėms.
5. Sukurkite pirmą admin vartotoją priedų moduliui: `node scripts/bootstrap-admin.mjs` (žr. 3 skyrių dėl `SUPABASE_SERVICE_ROLE_KEY`).

> **Apie RLS:** `items`, `pallets`, `catalog` numatytos prieigai per **authenticated** vartotojus. `shipments` leidžia prieigą ir `anon`, ir `authenticated` (nes siuntų formavimas veikia be prisijungimo ekrano). `parts`/`profiles`/`user_permissions` prieinamos tik `authenticated` vartotojams, papildomai apribotos pagal konkrečią teisę (`has_permission`). Jei pagrindinį srautą naudosite tik vidiniame tinkle be prisijungimo ekrano, pakeiskite likusias `to authenticated` į `to anon` schema faile — bet tuomet svarbu, kad programa nebūtų pasiekiama iš viešo interneto be papildomos apsaugos (pvz. VPN, IP apribojimas).

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

### Priedų (spare parts) modulis (reikia prisijungimo)

- **Prisijungimas (`/login`)** — ID (ne el. paštas) + slaptažodis. Sėkmingai prisijungus, nukreipia į puslapį, iš kurio buvo peradresuotas (arba `/priedai`).
- **Priedai (`/priedai`, reikia „view“ teisės)** — priedų sąrašas su paieška, filtrais (lokacija, mažas/nulinis likutis), puslapiavimu; su „edit“ teise galima keisti kiekį/pastabas/laukus ar pridėti naują įrašą tiesiogiai lentelėje, su „delete“ — trinti; Excel eksportas.
- **Priedų importas (`/priedai/importas`, reikia „import“ teisės)** — Excel įkėlimas, stulpelių atspėjimas (`excelHeaders.js`), importas per `import_parts` RPC (visada `insert`, nes `part_code` nėra unikalus); pasirinktinai prieš importą išvalyti esamus įrašus (reikia papildomai „delete“ teisės).
- **Vartotojai (`/priedai/vartotojai`, reikia „admin“ teisės arba `is_admin`)** — naujo vartotojo (ID + slaptažodis) kūrimas per `api/create-user.js`, esamų vartotojų teisių (view/edit/delete/import) ir admin žymos perjungimas.

## 6. Tolimesni žingsniai (pasiūlymai)

- Priedų modulyje jau yra Supabase Auth + teisėmis pagrįstas RLS (žr. 2 skyrių) — apsvarstyti tą patį pagrindiniam sandėlio srautui (`items`/`pallets`/`shipments`), pereinant nuo `anon` prie `authenticated` RLS taisyklių, jei prireiks atskirti darbuotojus.
- Naudoti realų barkodų skenerį (USB/Bluetooth HID skeneriai veikia be papildomo kodo, nes emuliuoja klaviatūrą).
- Pridėti `item_history` peržiūros ekraną prekės detalėje, jei prireiks pilnos audito istorijos.
- Apsvarstyti nuorodą į `/katalogas` navigacijoje su rolėmis pagrįsta prieiga, vietoj slapto tiesioginio adreso (kiti administraciniai puslapiai jau apsaugoti `RequirePermission`).
