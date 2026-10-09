import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { fetchAllRows } from "../lib/fetchAll";
import { DEFAULT_MIN_QUANTITY } from "../lib/stockLevel";

// Mažas mygtukas "Užsakymo sąrašas (Excel)" prie sandėlio būklės plytelių:
// vienu failu eksportuoja VISUS pasibaigusius ir mažo likučio įrašus
// (pirmiausia pasibaigę, tada mažiausio likučio). Pačio sąrašo /statistika
// puslapyje nerodome — plytelės "Mažo likučio"/"Pasibaigę" jau veda į
// filtruotus sąrašus (/priedai?likutis=…).
//
// Priedai skaito part_totals, prietaisai — device_totals view (abiem
// stock_level skaičiuojamas nuo bendro kiekio per visas lokacijas).

const LEVELS = ["out", "low"];

const KINDS = {
  parts: {
    table: "part_totals",
    select: "id, part_code, name, main_model, total_quantity, min_quantity, stock_level, locations_text",
    quantityField: "total_quantity",
    filePrefix: "priedai",
    normalize: (r) => ({
      level: r.stock_level,
      label: r.name || r.part_code,
      sub: r.main_model || "",
      code: r.part_code,
      quantity: r.total_quantity,
      min: r.min_quantity ?? DEFAULT_MIN_QUANTITY,
      // locations_text = "|8 (-1-)|42|" → "8 (-1-), 42"
      location: String(r.locations_text || "").split("|").filter(Boolean).join(", ")
    })
  },
  devices: {
    table: "device_totals",
    select: "id, ian, name, manufacturer, total_quantity, min_quantity, stock_level",
    quantityField: "total_quantity",
    filePrefix: "prietaisai",
    normalize: (r) => ({
      level: r.stock_level,
      label: r.name || r.ian,
      sub: r.manufacturer || "",
      code: r.ian,
      quantity: r.total_quantity,
      min: r.min_quantity ?? DEFAULT_MIN_QUANTITY,
      location: ""
    })
  }
};

// stock_level DESC → "out" prieš "low"; tada mažiausias kiekis pirmas.
// "id" — antrinis raktas: nei kiekis, nei pavadinimas nėra unikalūs, todėl be
// jo fetchAllRows puslapiavimas (kelios atskiros .range() užklausos) galėtų
// ties riboje nenuosekliai praleisti arba dubliuoti eilutę.
function baseQuery(cfg) {
  return supabase
    .from(cfg.table)
    .select(cfg.select)
    .in("stock_level", LEVELS)
    .order("stock_level", { ascending: false })
    .order(cfg.quantityField, { ascending: true })
    .order("name", { ascending: true })
    .order("id", { ascending: true });
}

// "count" — pasibaigusių + mažo likučio skaičius iš sandėlio būklės plytelių;
// kai 0, mygtuko nėra ką eksportuoti, todėl nerodomas.
export default function ReorderExportButton({ kind, count }) {
  const cfg = KINDS[kind];
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");

  async function handleExport() {
    setExporting(true);
    setError("");
    try {
      const [rows, { exportStockAlertsToExcel }] = await Promise.all([
        fetchAllRows(() => baseQuery(cfg)),
        import("../lib/exportExcel")
      ]);
      await exportStockAlertsToExcel(
        rows.map(cfg.normalize),
        kind,
        `Uzsakymui-${cfg.filePrefix}-${new Date().toISOString().slice(0, 10)}.xlsx`
      );
    } catch (e) {
      setError(e?.message || "Nepavyko sugeneruoti failo.");
    }
    setExporting(false);
  }

  if (!count) return null;

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-signal-red">{error}</span>}
      <button
        type="button"
        onClick={handleExport}
        disabled={exporting}
        title="Visi pasibaigę ir mažo likučio įrašai viename Excel faile"
        className="btn-secondary px-2.5 py-1 text-xs"
      >
        {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
        Užsakymo sąrašas (Excel)
      </button>
    </div>
  );
}
