import { readFileSync } from "node:fs";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Perskaito vieną reikšmę tiesiai iš nurodyto .env failo (be .env.local
// perrašymo) — Vite loadEnv() grąžina jau sulietą rezultatą.
function readEnvFileValue(file, key) {
  try {
    const line = readFileSync(new URL(file, import.meta.url), "utf8")
      .split(/\r?\n/)
      .find((l) => l.trim().startsWith(`${key}=`));
    return line ? line.slice(line.indexOf("=") + 1).trim() : "";
  } catch {
    return "";
  }
}

export default defineConfig(({ mode }) => {
  // .env pagal README (3 skyrius) — PRODUKCINIO projekto reikšmės, o
  // .env.local — lokalus testinis projektas. Jei aktyvus Supabase URL sutampa
  // su .env, vadinasi .env.local jo nepakeitė ir lokaliai dirbama su gyva DB —
  // EnvBanner tada rodo raudoną įspėjimą vietoj "TESTINĖ DB". Produkcijos
  // adresas čia nekoduojamas.
  const activeUrl = loadEnv(mode, process.cwd(), "VITE_").VITE_SUPABASE_URL;
  const envFileUrl = readEnvFileValue("./.env", "VITE_SUPABASE_URL");

  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_DB_IS_PRODUCTION": JSON.stringify(!!envFileUrl && activeUrl === envFileUrl)
    },
    server: {
      port: 5173,
      host: true
    }
  };
});
