# Sandėlio valdymo sistema (IAN skenavimas, paletės, būsenos)

Vidinė valdymo sistema, pakeičianti Excel/Google Sheets lentelę: prekių registravimas pagal IAN kodą, realaus laiko lentelė, paviečių/siuntų (palečių) formavimas ir būsenų valdymas, paieška ir redagavimas.

**Stack:** Vite + React + Tailwind CSS + Supabase (PostgreSQL, Realtime).

## 1. Projekto struktūra

```
warehouse-app/
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── .env.example              ← nukopijuokite į .env
├── supabase/
│   └── schema.sql             ← paleidžiama Supabase SQL Editor'iuje
└── src/
    ├── main.jsx
    ├── App.jsx                 ← maršrutai (routes)
    ├── index.css                ← Tailwind + bendri stiliai
    ├── lib/
    │   ├── supabaseClient.js    ← Supabase klientas
    │   └── constants.js         ← būsenų sąrašai ir spalvos
    ├── components/
    │   ├── Layout.jsx            ← šoninė/apatinė navigacija
    │   └── StatusBadge.jsx
    └── pages/
        ├── ScanEntry.jsx         ← "/"  — IAN skenavimas / registravimas
        ├── ItemsTable.jsx        ← "/prekes" — realaus laiko lentelė, paieška, filtrai, redagavimas
        ├── Pallets.jsx           ← "/paletes" — palečių sąrašas, kūrimas
        └── PalletDetail.jsx      ← "/paletes/:id" — prekių priskyrimas paletei, būsenos keitimas
```

## 2. Duomenų bazės struktūra (Supabase SQL schema)

Visa schema yra faile `supabase/schema.sql`. Trumpai:

### Lentelė `items` (pavienės prekės / įrankiai)

| Stulpelis    | Tipas       | Paskirtis                                              |
|--------------|-------------|---------------------------------------------------------|
| `id`         | uuid (PK)   | Unikalus identifikatorius                               |
| `ian`        | text, unique| Skenuojamas/įvedamas kodas — **unikalus**, apsaugo nuo dublikatų |
| `name`       | text        | Prekės pavadinimas (nebūtina)                            |
| `category`   | text        | Kategorija (nebūtina)                                    |
| `status`     | text        | `registered` → `checked` → `packed` → `shipped` / `rejected` |
| `notes`      | text        | Laisva pastaba                                            |
| `pallet_id`  | uuid (FK)   | Nuoroda į `pallets.id`, jei prekė priskirta paletei      |
| `created_at` | timestamptz | Sukūrimo laikas                                            |
| `updated_at` | timestamptz | Atnaujinama automatiškai per trigerį                       |

### Lentelė `pallets` (paletės / siuntos)

| Stulpelis    | Tipas       | Paskirtis                                       |
|--------------|-------------|--------------------------------------------------|
| `id`         | uuid (PK)   | Unikalus identifikatorius                        |
| `code`       | text, unique| Paletės kodas, pvz. `PAL-2026-001`                |
| `status`     | text        | `open` → `closed` → `shipped` → `delivered`      |
| `notes`      | text        | Pastaba                                           |
| `created_at` | timestamptz | Sukūrimo laikas                                    |
| `shipped_at` | timestamptz | Išsiuntimo laikas (nebūtina, galite pildyti patys) |

### Lentelė `item_history` (nebūtina, bet naudinga)

Automatiškai registruoja kiekvieną `items.status` pasikeitimą (auditui / istorijai).

### Kaip įdiegti

1. Supabase projekto skydelyje eikite į **SQL Editor**.
2. Įkelkite ir paleiskite visą `supabase/schema.sql` failo turinį.
3. Tai sukurs lenteles, indeksus, RLS (Row Level Security) taisykles ir įjungs Realtime `items`/`pallets` lentelėms.

> **Apie RLS:** schema numatyta prieigai per **authenticated** vartotojus (t. y. jei ateityje pridėsite prisijungimą per Supabase Auth). Jei aplikaciją naudosite tik vidiniame tinkle be prisijungimo ekrano, galite schema faile pakeisti `to authenticated` į `to anon` — bet tuomet svarbu, kad programa nebūtų pasiekiama iš viešo interneto be papildomos apsaugos (pvz. VPN, IP apribojimas).

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

- **Skenavimas (`/`)** — didelis mono šrifto laukas priima skenerio arba rankinę įvestį. Skeneris veikia kaip klaviatūra + Enter, todėl papildomos integracijos nereikia. IAN kodas yra `unique`, todėl dvigubo registravimo klaida bus aiškiai parodyta.
- **Prekių lentelė (`/prekes`)** — duomenys atsinaujina realiu laiku per Supabase Realtime (`postgres_changes` prenumerata), be puslapio perkrovimo. Yra paieška (IAN/pavadinimas/kategorija), filtras pagal būseną, redagavimo langas ir trynimas.
- **Paletės (`/paletes`)** — kuriamos naujos paletės, matomas prekių skaičius ir būsena kiekvienoje.
- **Paletės detalė (`/paletes/:id`)** — pridėti prekę prie paletės tereikia įvesti/nuskenuoti jos IAN kodą (prekė automatiškai pažymima kaip „Supakuota“); galima keisti pačios paletės būseną (formuojama → uždaryta → išsiųsta → pristatyta).

## 6. Tolimesni žingsniai (pasiūlymai)

- Pridėti **Supabase Auth** (el. paštu arba magic link) darbuotojų prisijungimui ir tada pereiti nuo `anon` prie `authenticated` RLS taisyklių.
- Naudoti realų barkodų skenerį (USB/Bluetooth HID skeneriai veikia be papildomo kodo, nes emuliuoja klaviatūrą).
- Pridėti eksportą į CSV/Excel iš „Prekių lentelės“ puslapio ataskaitoms.
- Pridėti `item_history` peržiūros ekraną prekės detalėje, jei prireiks pilnos audito istorijos.
