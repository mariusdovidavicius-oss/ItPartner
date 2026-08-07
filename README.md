# Sandėlio valdymo sistema (IAN skenavimas, paletės, siuntos)

Vidinė valdymo sistema, pakeičianti Excel/Google Sheets lentelę: prekių registravimas pagal IAN kodą, realaus laiko lentelė, automatinis paskirstymas į paletes pagal gamintoją/tipą, palečių grupavimas į siuntas ir būsenų valdymas, paieška ir redagavimas.

**Stack:** Vite + React + React Router + Tailwind CSS + Supabase (PostgreSQL, Realtime) + SheetJS (xlsx) Excel eksportui/importui.

## 1. Projekto struktūra

```
warehouse-app/
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── .env.example                  ← nukopijuokite į .env
├── supabase/
│   ├── schema.sql                 ← pilna, dabartinė schema (paleidžiama naujai DB)
│   └── migrate_*.sql              ← papildomos migracijos jau egzistuojančiai DB
│       (add_quantity, add_destination, dynamic_destination, shipments,
│        manual_shipment_selection, pallet_number, drop_pallet_code_unique,
│        reset_function, reset_pallet_numbering — žr. 2 skyrių)
└── src/
    ├── main.jsx
    ├── App.jsx                    ← maršrutai (routes)
    ├── index.css                   ← Tailwind + bendri stiliai
    ├── lib/
    │   ├── supabaseClient.js       ← Supabase klientas
    │   ├── constants.js            ← būsenų sąrašai (ITEM/PALLET/SHIPMENT) ir spalvos
    │   └── destination.js          ← "paskirties" (destination) skaičiavimas iš gamintojo+tipo
    ├── components/
    │   ├── Layout.jsx               ← šoninė/apatinė navigacija
    │   └── StatusBadge.jsx
    └── pages/
        ├── ScanEntry.jsx            ← "/" — IAN skenavimas/registravimas, atviros paletės
        ├── ItemsTable.jsx           ← "/prekes" — realaus laiko lentelė, paieška, filtrai, redagavimas
        ├── Pallets.jsx              ← "/paletes" — laukiančios paletės, rankinis siuntų formavimas, Excel eksportas
        ├── PalletDetail.jsx         ← "/paletes/:id" — paletės turinys, būsenos keitimas, prekės pašalinimas
        ├── CatalogImport.jsx        ← "/katalogas" — admin: katalogo (IAN → pavadinimas/gamintojas/tipas) importas iš Excel/CSV
        └── AdminReset.jsx           ← "/admin-reset" — admin: visų testavimo duomenų išvalymas
```

Puslapiai `/katalogas` ir `/admin-reset` yra administraciniai — pasiekiami tik tiesioginiu adresu, be nuorodos navigacijos meniu (`App.jsx` komentaras).

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

Iškviečiama iš `/admin-reset` puslapio (RPC), reikalauja rankinio patvirtinimo žodžio. Negrįžtamai išvalo `items`, `pallets`, `shipments`, `item_history` bei `pallet_number_counters` — skirta tik testavimui.

### Kaip įdiegti

1. Supabase projekto skydelyje eikite į **SQL Editor**.
2. **Naujam projektui** — įkelkite ir paleiskite visą `supabase/schema.sql` failo turinį (jis apima ir katalogą, siuntas, dinaminę paskirtį).
3. **Esamam projektui, kuris kurtas anksčiau** — paleiskite trūkstamas `migrate_*.sql` migracijas chronologine tvarka (žr. failo pavadinimą ir komentarą jo viršuje).
4. Tai sukurs lenteles, indeksus, RLS (Row Level Security) taisykles ir įjungs Realtime `items`/`pallets`/`shipments` lentelėms.

> **Apie RLS:** `items`, `pallets`, `catalog` numatytos prieigai per **authenticated** vartotojus. `shipments` leidžia prieigą ir `anon`, ir `authenticated` (nes siuntų formavimas veikia be prisijungimo ekrano). Jei aplikaciją naudosite tik vidiniame tinkle be prisijungimo ekrano, pakeiskite likusias `to authenticated` į `to anon` schema faile — bet tuomet svarbu, kad programa nebūtų pasiekiama iš viešo interneto be papildomos apsaugos (pvz. VPN, IP apribojimas).

## 3. Sujungimas su Supabase (.env kintamieji)

1. Supabase Dashboard → **Project Settings → API** rasite:
   - `Project URL`
   - `anon public` raktą
2. Projekto šaknyje nukopijuokite `.env.example` į `.env`:

   ```bash
   cp .env.example .env
   ```

3. Įrašykite savo reikšmes:

   ```
   VITE_SUPABASE_URL=https://jusu-projektas.supabase.co
   VITE_SUPABASE_ANON_KEY=jusu-anon-public-raktas
   ```

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

- **Skenavimas (`/`)** — didelis mono šrifto laukas priima skenerio arba rankinę įvestį. Skeneris veikia kaip klaviatūra + Enter, todėl papildomos integracijos nereikia. Nuskenavus IAN kodą, sistema jį ieško `catalog` lentelėje, automatiškai užpildo pavadinimą ir apskaičiuoja paskirtį (gamintojas + tipas). Prekė automatiškai priskiriama atviros tos paskirties paletės (jei tokios nėra — sukuriama nauja), o skenuojant tą patį IAN toje pačioje paletėje pakartotinai — didinamas `quantity`, o ne kuriamas naujas įrašas. Puslapyje matomos visos šiuo metu atviros paletės su galimybe pažymėti „Išvežta“ (uždaryti).
- **Prekių lentelė (`/prekes`)** — duomenys atsinaujina realiu laiku per Supabase Realtime (`postgres_changes` prenumerata), be puslapio perkrovimo. Yra paieška (IAN/pavadinimas/kategorija), filtras pagal būseną, redagavimo langas (įskaitant kiekį ir paletę) ir trynimas.
- **Paletės (`/paletes`)** — rodomos uždarytos, bet siuntai dar nepriskirtos paletės, filtruojamos pagal paskirtį; vartotojas pažymi checkbox'ais kelias paletes ir vienu veiksmu pažymi jas kaip išvežtas (sukuriama nauja siunta) arba atsisiunčia Excel sąrašą pagal paletę/pavadinimą/kiekį/IAN kodus. Žemiau matoma jau išsiųstų siuntų istorija su galimybe pakartotinai atsisiųsti Excel.
- **Paletės detalė (`/paletes/:id`)** — matomas visas paletės turinys (IAN, pavadinimas, kiekis, būsena), galima pašalinti prekę iš paletės arba keisti pačios paletės būseną (formuojama → uždaryta → išsiųsta → pristatyta).
- **Katalogo importas (`/katalogas`, admin)** — Excel/CSV įkėlimas, stulpelio su „Pavadinimas (IAN)“ tekstu pasirinkimas (IAN automatiškai ištraukiamas iš skliaustelių), nebūtini gamintojo/tipo stulpeliai paskirties skaičiavimui. Importas veikia partijomis (upsert pagal IAN), rodo progresą ir suvestinę (nauji/atnaujinti/nepavykę).
- **Administravimas (`/admin-reset`, admin)** — testavimo duomenų (prekės, paletės, siuntos, istorija, numeravimo skaitliukai) negrįžtamas išvalymas, apsaugotas patvirtinimo žodžiu.

## 6. Tolimesni žingsniai (pasiūlymai)

- Pridėti **Supabase Auth** (el. paštu arba magic link) darbuotojų prisijungimui ir tada pereiti nuo `anon` prie `authenticated` RLS taisyklių (ypač `shipments` lentelei).
- Naudoti realų barkodų skenerį (USB/Bluetooth HID skeneriai veikia be papildomo kodo, nes emuliuoja klaviatūrą).
- Pridėti `item_history` peržiūros ekraną prekės detalėje, jei prireiks pilnos audito istorijos.
- Apsvarstyti nuorodą į administracinius puslapius (`/katalogas`, `/admin-reset`) navigacijoje su rolėmis pagrįsta prieiga, vietoj slapto tiesioginio adreso.
