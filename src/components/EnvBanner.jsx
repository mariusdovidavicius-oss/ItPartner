import { FlaskConical, TriangleAlert } from "lucide-react";

// Nuolatinė juosta VIRŠ viso puslapio, rodoma TIK lokaliai (`npm run dev`).
// Produkciniame build'e import.meta.env.DEV yra false, todėl komponentas
// (ir jo tekstai) iš bundle'o išmetami.
//
// VITE_DB_IS_PRODUCTION nustatomas vite.config.js: true, jei aktyvus
// Supabase URL sutampa su .env (produkcija) — t.y. .env.local nepakeitė
// reikšmių ir lokalus dev serveris rašo į GYVĄ DB. Tada juosta raudona.
function dbHost() {
  try {
    return new URL(import.meta.env.VITE_SUPABASE_URL).host;
  } catch {
    return "nenustatyta";
  }
}

export default function EnvBanner() {
  if (!import.meta.env.DEV) return null;

  const isProduction = import.meta.env.VITE_DB_IS_PRODUCTION === true;
  const Icon = isProduction ? TriangleAlert : FlaskConical;

  return (
    <div
      role="status"
      className={`sticky top-0 z-30 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 px-4 py-1.5 text-center text-xs font-semibold ${
        isProduction ? "bg-signal-red text-white" : "bg-signal-amber text-ink-950"
      }`}
    >
      <Icon size={14} className="shrink-0" />
      {isProduction ? (
        <span>
          DĖMESIO: PRODUKCINĖ DB — lokaliai dirbate su gyvais duomenimis (patikrinkite .env.local)
        </span>
      ) : (
        <span>TESTINĖ DB — lokali aplinka, gyvi duomenys neliečiami</span>
      )}
      <span className="font-mono font-normal opacity-80">{dbHost()}</span>
    </div>
  );
}
