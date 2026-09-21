// Užpildo TESTINĮ Supabase projektą bandomaisiais priedų (parts) duomenimis
// ir nurašymų istorija. Rašo tiesiai per service_role (apeina RLS), nes
// import_parts RPC nenustato min_quantity/notes ir reikalauja prisijungusio
// vartotojo.
//
// SAUGIKLIS: skriptas atsisako veikti, jei aktyvus Supabase URL sutampa su
// .env (produkcija) arba .env.local dar neužpildytas.
//
// Naudojimas:
//   node scripts/seed-test-parts.mjs            (nieko nedaro, jei parts jau turi įrašų)
//   node scripts/seed-test-parts.mjs --replace  (prieš tai IŠTRINA visus priedus ir jų nurašymus TESTINĖJE DB)

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function readEnvFile(file) {
  const env = {};
  try {
    const content = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    content.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const idx = trimmed.indexOf("=");
      if (idx === -1) return;
      env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    });
  } catch {
    // failo gali nebūti
  }
  return env;
}

// Kaip Vite / bootstrap-admin: .env.local turi pirmenybę prieš .env.
const prodEnv = readEnvFile(".env");
const env = { ...prodEnv, ...readEnvFile(".env.local"), ...process.env };
const url = env.VITE_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error("Trūksta VITE_SUPABASE_URL arba SUPABASE_SERVICE_ROLE_KEY (.env.local).");
  process.exit(1);
}

const host = new URL(url).host;
console.log(`Tikslinė DB: ${host}`);

if (/replace-with/i.test(host)) {
  console.error("ATSISAKOMA: .env.local dar neužpildytas (placeholder'is vietoj testinio projekto).");
  process.exit(1);
}
if (prodEnv.VITE_SUPABASE_URL && new URL(prodEnv.VITE_SUPABASE_URL).host === host) {
  console.error("ATSISAKOMA: tikslinė DB sutampa su .env (produkcija). Šis skriptas skirtas tik testiniam projektui.");
  process.exit(1);
}

const replace = process.argv.includes("--replace");

// [lokacija, pagrindinis modelis, detalės kodas, pavadinimas, kiekis, min. kiekis, el. parduotuvė, suderinami modeliai, pastaba]
const PARTS = [
  // --- pakankamas likutis ---
  ["12", "Parkside PSSA 20-Li A1", "352083/ZU21", "Anglinių šepetėlių komplektas", 14, null, true, "PSSA 20-Li A1; PSSA 20-Li B2", null],
  ["12", "Parkside PSSA 20-Li A1", "352086", "Pjūklo juostos laikiklis", 9, null, false, "PSSA 20-Li A1", null],
  ["13 (-2-)", "Parkside PWSA 20-Li B2", "356410", "Šlifavimo disko apsauga", 22, null, true, "PWSA 20-Li B2; PWSA 20-Li A1; PWSA 20-Li B1", "Dėžė ant viršutinės lentynos"],
  ["13 (-2-)", "Parkside PWSA 20-Li B2", "356411", "Pavarų dėžė su velenu", 6, null, true, "PWSA 20-Li B2", null],
  ["14", "Parkside PABS 20-Li A1", "349921", "Griebtuvas 13 mm", 18, null, true, "PABS 20-Li A1; PABS 20-Li B2; PABS 20-Li C3", null],
  ["14", "Parkside PABS 20-Li A1", "349925", "Perjungiklis su reversu", 11, null, false, "PABS 20-Li A1", null],
  ["15 (-1-)", "Parkside PKS 1800 A1", "341207", "Pjovimo disko apsauginis gaubtas", 7, null, true, "PKS 1800 A1", null],
  ["15 (-1-)", "Parkside PKS 1800 A1", "341208", "Rankenos komplektas", 25, null, true, "PKS 1800 A1; PKS 1800 B2", null],
  ["16", "Parkside PDSM 600 A1", "338760", "Šlifavimo padas su lipnia juosta", 40, null, true, "PDSM 600 A1; PDSM 600 B2; PDSM 600 C3; PDSM 600 D4", "Perkame po 40 vnt."],
  ["16", "Parkside PDSM 600 A1", "338761", "Dulkių maišelis", 33, null, true, "PDSM 600 A1", null],
  ["17 (-4-)", "Parkside PHSP 1600 A1", "362114", "Oro srauto pūtiklis", 5, null, false, "PHSP 1600 A1", null],
  ["17 (-4-)", "Parkside PHSP 1600 A1", "362115", "Šildymo elementas 1600 W", 8, null, true, "PHSP 1600 A1; PHSP 1600 B2", null],
  ["18", "Silvercrest SHC 1500 B2", "371002", "Šildytuvo termostatas", 12, null, true, "SHC 1500 B2", null],
  ["18", "Silvercrest SHC 1500 B2", "371003", "Ventiliatoriaus variklis", 4, null, false, "SHC 1500 B2; SHC 1500 A1", null],
  ["19 (-3-)", "Florabest FEH 2000 A1", "384450", "Pjovimo galvutės peiliukas", 30, null, true, "FEH 2000 A1; FEH 2000 B2", null],
  ["19 (-3-)", "Florabest FEH 2000 A1", "384451", "Apsauginis gaubtas", 16, null, false, "FEH 2000 A1", null],
  ["20", "Grizzly ERM 2500", "391870", "Anglinių šepetėlių pora", 50, null, true, "ERM 2500; ERM 2500 B", null],
  ["20", "Grizzly ERM 2500", "391871", "Statoriaus ritė", 6, null, false, "ERM 2500", "Tikrinti prieš siunčiant"],
  ["42 (-7-)", "Parkside PSSA 20-Li A1", "352090", "Akumuliatoriaus fiksatorius", 19, null, true, "PSSA 20-Li A1; PABS 20-Li A1; PWSA 20-Li B2; PKS 1800 A1", null],
  ["42 (-7-)", "Parkside PABS 20-Li A1", "349930", "Krovimo lizdo plokštė", 10, null, false, "PABS 20-Li A1", null],
  // --- pasikartojantis kodas skirtingose lokacijose (leidžiama) ---
  ["21", "Parkside PWSA 20-Li B2", "356420", "Guolis 6001", 24, null, true, "PWSA 20-Li B2; PSSA 20-Li A1", null],
  ["43 (-8-)", "Parkside PWSA 20-Li B2", "356420", "Guolis 6001", 15, null, true, "PWSA 20-Li B2; PSSA 20-Li A1", "Antra lokacija — likutis iš grąžinimų"],
  // --- mažas likutis pagal numatytąjį slenkstį (≤ 3) ---
  ["22", "Parkside PSSA 20-Li A1", "352095", "Pjūklo pavara", 3, null, true, "PSSA 20-Li A1", null],
  ["22", "Parkside PKS 1800 A1", "341215", "Apsauginis jungiklis", 2, null, false, "PKS 1800 A1", "Užsakyti iš tiekėjo"],
  ["23 (-5-)", "Parkside PDSM 600 A1", "338770", "Ekscentriko mechanizmas", 1, null, true, "PDSM 600 A1; PDSM 600 B2", null],
  // --- mažas likutis pagal INDIVIDUALŲ slenkstį ---
  ["24", "Parkside PABS 20-Li A1", "349940", "Greičių perjungimo mechanizmas", 8, 10, true, "PABS 20-Li A1; PABS 20-Li B2", "Greitai išparduodamas — slenkstis 10"],
  ["24", "Parkside PWSA 20-Li B2", "356430", "Suklio fiksavimo mygtukas", 15, 20, true, "PWSA 20-Li B2", null],
  // --- likutis 4, bet slenkstis žemesnis nei numatytasis → OK ---
  ["25", "Grizzly ERM 2500", "391880", "Reguliavimo rankenėlė", 4, 2, false, "ERM 2500", "Retai naudojama — slenkstis 2"],
  // --- baigėsi (0) ---
  ["26", "Parkside PSSA 20-Li A1", "352100", "Pjūklo rėmas", 0, null, true, "PSSA 20-Li A1; PSSA 20-Li B2", "Laukiame pristatymo"],
  ["26", "Parkside PKS 1800 A1", "341220", "Nulinės padėties atrama", 0, null, false, "PKS 1800 A1", null],
  ["27 (-6-)", "Silvercrest SHC 1500 B2", "371010", "Šildymo spiralė", 0, null, true, "SHC 1500 B2", null],
  ["27 (-6-)", "Florabest FEH 2000 A1", "384460", "Peilių bloko komplektas", 0, 5, true, "FEH 2000 A1; FEH 2000 B2", "Išparduota — reikia papildyti"],
  ["28", "Parkside PABS 20-Li A1", "349950", "Kabelio įvorė", 0, null, false, "PABS 20-Li A1", null],
  // --- kraštutiniai atvejai: trūksta pavadinimo / modelio / suderinamų modelių ---
  ["29", "Parkside PHSP 1600 A1", "362120", null, 7, null, false, "PHSP 1600 A1", "Pavadinimas nenurodytas importe"],
  ["29", null, "999001", "Universali tarpinė", 12, null, true, null, null],
  ["30", null, "999002/AB", "Mažų varžtų rinkinys M3", 60, null, true, null, "Nėra konkretaus modelio"],
  // --- labai ilgas suderinamų modelių sąrašas (išskleidimo/lentelės testui) ---
  ["31", "Parkside PABS 20-Li A1", "349960", "Universalus akumuliatoriaus adapteris", 9, null, true,
    "PABS 20-Li A1; PABS 20-Li B2; PABS 20-Li C3; PSSA 20-Li A1; PSSA 20-Li B2; PWSA 20-Li A1; PWSA 20-Li B2; PKS 1800 A1; PKS 1800 B2; PDSM 600 A1; PHSP 1600 A1; PHSP 1600 B2", null]
];

// [priedo indeksas PARTS masyve, kiekis, priežastis, VIENETO kaina (parduota) / RMA / tekstas, prieš kiek dienų, atšauktas?]
//
// DĖMESIO: parts_writeoffs.price DB yra SUMA UŽ VISĄ nurašomą kiekį (taip ją
// įveda žmonės formoje ir taip sumuoja /statistika), todėl "parduota"
// eilutėse čia rašoma kaina už VIENETĄ, o į DB skriptas įrašo kaina × kiekis.
const WRITEOFFS = [
  [0, 2, "parduota", 6.9, 3],       // 2 × 6,90 = 13,80 €
  [0, 1, "remontui", "RMA-2026-0142", 9],
  [4, 3, "parduota", 8.5, 5],       // 3 × 8,50 = 25,50 €
  [8, 10, "parduota", 1.2, 12],     // 10 × 1,20 = 12,00 €
  [8, 5, "parduota", 1.2, 27],      // 5 × 1,20 = 6,00 €
  [16, 6, "parduota", 2.5, 2],      // 6 × 2,50 = 15,00 €
  [16, 4, "kita", "Sugadinta pakuotė", 15],
  [21, 1, "remontui", "RMA-2026-0157", 6],
  [22, 3, "parduota", 10.9, 1],     // 3 × 10,90 = 32,70 €
  [26, 2, "parduota", 3.2, 20, true], // 2 × 3,20 = 6,40 € (atšauktas)
  [31, 5, "parduota", 4.9, 40],     // 5 × 4,90 = 24,50 €
  [28, 1, "kita", "Numesta, sulūžo", 55],
  [30, 4, "remontui", "RMA-2026-0101", 70]
];

// Tinklo dalis funkcijoje su return (o ne process.exit) — Windows'e exit() prieš
// pasibaigiant fetch ryšiams išmeta "Assertion failed: UV_HANDLE_CLOSING".
async function main() {
  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { count: existing, error: countError } = await supabase
    .from("parts")
    .select("id", { count: "exact", head: true });
  if (countError) {
    console.error("Nepavyko nuskaityti parts lentelės:", countError.message);
    process.exitCode = 1;
    return;
  }

  if (existing > 0 && !replace) {
    console.log(`parts jau turi ${existing} įrašų — nieko nedaroma. Norėdami perrašyti: --replace`);
    process.exitCode = 0;
    return;
  }

  if (existing > 0 && replace) {
    // parts_writeoffs išsivalo per "on delete cascade"
    const { error } = await supabase.from("parts").delete().not("id", "is", null);
    if (error) {
      console.error("Nepavyko išvalyti parts:", error.message);
      process.exitCode = 1;
      return;
    }
    console.log(`Ištrinta ${existing} senų priedų (kartu su jų nurašymais).`);
  }

  const { data: admin } = await supabase
    .from("profiles")
    .select("id, username")
    .eq("is_admin", true)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (!admin) console.warn("Adminas nerastas — nurašymai bus be vartotojo (user_id = NULL).");

  const rows = PARTS.map(
    ([location, main_model, part_code, name, quantity, min_quantity, online_store, compatible_models, notes]) => ({
      location, main_model, part_code, name, quantity, min_quantity, online_store, compatible_models, notes
    })
  );

  const { data: inserted, error: insertError } = await supabase
    .from("parts")
    .insert(rows)
    .select("id, part_code, location, stock_level");
  if (insertError) {
    console.error("Klaida įrašant priedus:", insertError.message);
    process.exitCode = 1;
    return;
  }

  // insert().select() grąžina eilutes ta pačia tvarka, kaip įrašytos
  const now = Date.now();
  const writeoffRows = WRITEOFFS.map(([idx, quantity, reason_type, detail, daysAgo, undone]) => {
    const createdAt = new Date(now - daysAgo * 86400000).toISOString();
    return {
      part_id: inserted[idx].id,
      user_id: admin?.id ?? null,
      quantity,
      reason_type,
      price: reason_type === "parduota" ? Math.round(detail * quantity * 100) / 100 : null,
      rma: reason_type === "remontui" ? detail : null,
      reason: reason_type === "kita" ? detail : null,
      created_at: createdAt,
      undone_at: undone ? new Date(now - (daysAgo - 1) * 86400000).toISOString() : null,
      undone_by: undone ? (admin?.id ?? null) : null
    };
  });

  const { error: writeoffError } = await supabase.from("parts_writeoffs").insert(writeoffRows);
  if (writeoffError) {
    console.error("Priedai įrašyti, bet nurašymų įrašyti nepavyko:", writeoffError.message);
    process.exitCode = 1;
    return;
  }

  const levels = inserted.reduce((acc, p) => ({ ...acc, [p.stock_level]: (acc[p.stock_level] || 0) + 1 }), {});
  console.log(`Įrašyta priedų: ${inserted.length} (ok: ${levels.ok || 0}, mažas likutis: ${levels.low || 0}, baigėsi: ${levels.out || 0})`);
  console.log(`Įrašyta nurašymų: ${writeoffRows.length} (1 atšauktas)${admin ? `, vartotojas: ${admin.username}` : ""}`);
}

await main();
