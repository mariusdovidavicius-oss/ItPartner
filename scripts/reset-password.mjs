// Pamiršto slaptažodžio keitimas (kai nėra kito admino, kuris galėtų jį
// pakeisti per Vartotojai → 🔑). Naudoja SUPABASE_SERVICE_ROLE_KEY.
//
// Naudojimas (savo terminale, ne per Claude):
//   node scripts/reset-password.mjs <id>           — TESTINĖ DB (.env.local)
//   node scripts/reset-password.mjs <id> --prod    — PRODUKCINĖ DB (tik .env)
// Naujas slaptažodis klausiamas terminale (nerodomas ekrane ir nelieka
// komandų istorijoje).

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createClient } from "@supabase/supabase-js";
import { idToEmail } from "../src/lib/authConstants.js";

const args = process.argv.slice(2);
const prod = args.includes("--prod");
const id = (args.find((a) => !a.startsWith("--")) || "").trim().toLowerCase();
if (!id) {
  console.error("Nurodykite vartotojo ID, pvz.: node scripts/reset-password.mjs marius --prod");
  process.exit(1);
}

// --prod: TIK .env (produkcija); kitaip .env.local turi pirmenybę (testinė DB).
function loadEnv() {
  const env = {};
  for (const file of prod ? [".env"] : [".env", ".env.local"]) {
    try {
      readFileSync(new URL(`../${file}`, import.meta.url), "utf8").split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return;
        const idx = trimmed.indexOf("=");
        env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
      });
    } catch {
      // failo gali nebūti
    }
  }
  return env;
}

const env = loadEnv();
if (!env.VITE_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Trūksta VITE_SUPABASE_URL arba SUPABASE_SERVICE_ROLE_KEY .env faile.");
  process.exit(1);
}

// Slaptažodžio įvedimas be rodymo ekrane.
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.startsWith(question)) rl.output.write(s);
      else if (s.includes("\n") || s.includes("\r")) rl.output.write("\n");
      else rl.output.write("*");
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

console.log(`Tikslinė DB: ${new URL(env.VITE_SUPABASE_URL).host} ${prod ? "(PRODUKCIJA)" : "(testinė)"}`);
console.log(`Vartotojas: ${id}`);

// process.exit() po tinklo užklausų Windows'e meta Node "Assertion failed" —
// todėl grąžinamas išėjimo kodas, o ne process.exit().
async function main() {
  const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const email = idToEmail(id);
  let found = null;
  for (let page = 1; !found; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      console.error("Nepavyko gauti vartotojų:", error.message);
      return 1;
    }
    found = data.users.find((u) => u.email?.toLowerCase() === email);
    if (data.users.length < 200) break;
  }
  if (!found) {
    console.error(`Vartotojas "${id}" nerastas šioje DB.`);
    return 1;
  }

  const password = await askHidden("Naujas slaptažodis: ");
  const repeat = await askHidden("Pakartokite: ");
  if (password.length < 6) {
    console.error("Slaptažodis turi būti bent 6 simbolių.");
    return 1;
  }
  if (password !== repeat) {
    console.error("Slaptažodžiai nesutampa.");
    return 1;
  }

  const { error: updateError } = await supabase.auth.admin.updateUserById(found.id, { password });
  if (updateError) {
    console.error("Nepavyko pakeisti:", updateError.message);
    return 1;
  }
  console.log(`Slaptažodis pakeistas. Prisijunkite kaip "${id}".`);
  return 0;
}

process.exitCode = await main();
