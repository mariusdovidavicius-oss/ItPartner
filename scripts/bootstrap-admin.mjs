// Vienkartinis skriptas pirmam admin vartotojui sukurti (kai dar nėra nė
// vieno admino, kuris galėtų sukurti kitus per /priedai/vartotojai).
// Reikalauja SUPABASE_SERVICE_ROLE_KEY .env faile (Supabase Dashboard ->
// Project Settings -> API -> "service_role" slaptas raktas). NIEKADA
// nekomituoti šio rakto ir nedėti VITE_ priešdėlio.
//
// Naudojimas:
//   node scripts/bootstrap-admin.mjs [id] [slaptazodis]
//   (numatytieji: marius / admin)

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { idToEmail } from "../src/lib/authConstants.js";

function loadEnv() {
  const env = {};
  try {
    const content = readFileSync(new URL("../.env", import.meta.url), "utf8");
    content.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const idx = trimmed.indexOf("=");
      if (idx === -1) return;
      env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    });
  } catch {
    // .env gali nebūti — tada pasikliaujama vien process.env
  }
  return { ...env, ...process.env };
}

const env = loadEnv();
const url = env.VITE_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    "Trūksta VITE_SUPABASE_URL arba SUPABASE_SERVICE_ROLE_KEY .env faile.\n" +
    "Pridėkite eilutę: SUPABASE_SERVICE_ROLE_KEY=<service_role raktas iš Supabase Dashboard> " +
    "(NE VITE_ priešdėliu)."
  );
  process.exit(1);
}

const id = (process.argv[2] || "marius").trim().toLowerCase();
const password = process.argv[3] || "admin";
const email = idToEmail(id);

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const { data: created, error } = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: true
});

if (error) {
  console.error("Klaida kuriant vartotoją:", error.message);
  process.exit(1);
}

const { error: updateError } = await supabase
  .from("profiles")
  .update({ is_admin: true })
  .eq("id", created.user.id);

if (updateError) {
  console.error("Vartotojas sukurtas, bet nepavyko pažymėti kaip admin:", updateError.message);
  process.exit(1);
}

console.log(`Adminas sukurtas. ID: "${id}", slaptažodis: "${password}"`);
