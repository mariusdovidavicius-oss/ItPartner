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

// Lokaliai (npm run dev) /api/*.js funkcijas Vercel'is nevykdo — šis
// tarpinis sluoksnis jas paleidžia per Vite su tuo pačiu (req, res) API
// (req.body JSON, res.status().json()). Aplinkos kintamieji — iš
// .env/.env.local (t. y. testinė DB). Produkcijoje nenaudojamas.
function localApi(env) {
  return {
    name: "local-api",
    apply: "serve",
    configureServer(server) {
      Object.assign(process.env, env);
      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/api\/([a-z0-9-]+)(?:\?.*)?$/i);
        if (!match) return next();
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const raw = Buffer.concat(chunks).toString("utf8");
          req.body = raw ? JSON.parse(raw) : {};
          res.status = (code) => {
            res.statusCode = code;
            return res;
          };
          res.json = (obj) => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(obj));
          };
          const mod = await server.ssrLoadModule(`/api/${match[1]}.js`);
          await mod.default(req, res);
        } catch (err) {
          console.error(err);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err.message || err) }));
        }
      });
    }
  };
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
    plugins: [react(), localApi(loadEnv(mode, process.cwd(), ""))],
    define: {
      "import.meta.env.VITE_DB_IS_PRODUCTION": JSON.stringify(!!envFileUrl && activeUrl === envFileUrl)
    },
    server: {
      port: 5173,
      host: true
    }
  };
});
