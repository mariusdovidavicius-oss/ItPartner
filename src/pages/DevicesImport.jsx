import { useEffect, useMemo, useState } from "react";
import { Upload, FileSpreadsheet, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { normalizeHeader } from "../lib/excelHeaders";
import { readSpreadsheetRows } from "../lib/readSpreadsheet";

const BATCH_SIZE = 500;

// Tikslinis devices/device_stock stulpelis -> antraščių tekstai (normalizuoti),
// pagal kuriuos bandoma automatiškai atspėti atitinkamą Excel stulpelį.
// Atitinka Excel šaltinį: A Prietaisas | B IAN | C Kiekis | D Lokacija |
// E Komentaras | F Gamintojas.
const FIELDS = [
  { key: "name", label: "Prietaisas", match: ["prietaisas"] },
  { key: "ian", label: "IAN", match: ["ian"] },
  { key: "quantity", label: "Kiekis", match: ["kiekis"] },
  { key: "location", label: "Lokacija", match: ["lokacija"] },
  { key: "notes", label: "Komentaras", match: ["komentaras"] },
  { key: "manufacturer", label: "Gamintojas", match: ["gamintojas"] }
];

function columnLabel(index) {
  let n = index;
  let label = "";
  do {
    label = String.fromCharCode((n % 26) + 65) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

// Excel eilutė (raw reikšmės pagal stulpelio indeksą) -> tipizuotas įrašas.
function toRecord(row, columnMap) {
  function cell(key) {
    const idx = columnMap[key];
    return idx === "" || idx === undefined ? "" : row[Number(idx)];
  }
  const ian = String(cell("ian") ?? "").trim();
  const quantityRaw = String(cell("quantity") ?? "").trim();
  const quantity = quantityRaw ? Number(quantityRaw) : 0;

  return {
    name: String(cell("name") ?? "").trim() || null,
    ian,
    quantity: Number.isFinite(quantity) ? quantity : 0,
    location: String(cell("location") ?? "").trim() || null,
    notes: String(cell("notes") ?? "").trim() || null,
    manufacturer: String(cell("manufacturer") ?? "").trim() || null
  };
}

export default function DevicesImport() {
  const [fileName, setFileName] = useState("");
  const [sheetRows, setSheetRows] = useState([]);
  const [columnCount, setColumnCount] = useState(0);
  const [columnMap, setColumnMap] = useState({});
  const [skipHeader, setSkipHeader] = useState(true);
  const [parseError, setParseError] = useState("");
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [existingCount, setExistingCount] = useState(null);
  const [clearExisting, setClearExisting] = useState(false);

  useEffect(() => {
    refreshExistingCount();
  }, []);

  async function refreshExistingCount() {
    const { count } = await supabase.from("devices").select("*", { count: "exact", head: true });
    setExistingCount(count ?? 0);
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError("");
    setResult(null);
    setFileName(file.name);

    try {
      const rows = await readSpreadsheetRows(file);
      const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
      setSheetRows(rows);
      setColumnCount(maxCols);

      const headerRow = rows[0] || [];
      const detected = {};
      FIELDS.forEach((f) => { detected[f.key] = ""; });
      headerRow.forEach((cell, i) => {
        const norm = normalizeHeader(cell);
        const field = FIELDS.find((f) => f.match.includes(norm));
        if (field) detected[field.key] = String(i);
      });
      setColumnMap(detected);
    } catch (err) {
      setParseError(`Nepavyko nuskaityti failo: ${err.message}`);
      setSheetRows([]);
      setColumnCount(0);
    }
  }

  const dataRows = useMemo(() => {
    if (!sheetRows.length) return [];
    return skipHeader ? sheetRows.slice(1) : sheetRows;
  }, [sheetRows, skipHeader]);

  const parsed = useMemo(() => {
    if (!dataRows.length) return [];
    return dataRows
      .filter((row) => row.some((cell) => String(cell ?? "").trim() !== ""))
      .map((row) => toRecord(row, columnMap));
  }, [dataRows, columnMap]);

  // Eilutės be IAN serverio pusėje (import_devices RPC) praleidžiamos, nes
  // neįmanoma identifikuoti modelio — ta pati taisyklė taikoma ir čia
  // peržiūrai/skaičiams, kad rodomas skaičius atitiktų realų importo rezultatą.
  const validEntries = useMemo(() => parsed.filter((p) => p.ian), [parsed]);
  const failedCount = parsed.length - validEntries.length;

  const previewRows = parsed.slice(0, 10);

  // Importas eina per import_devices() RPC (SECURITY DEFINER), ne tiesiogiai
  // per .insert() — taip 'import' teisė lieka atskira nuo 'edit'/'delete',
  // patikrinama pačioje DB funkcijoje.
  async function handleImport() {
    if (!validEntries.length) return;
    setImporting(true);
    setResult(null);

    const batches = [];
    for (let i = 0; i < validEntries.length; i += BATCH_SIZE) {
      batches.push(validEntries.slice(i, i + BATCH_SIZE));
    }

    let devicesCount = 0;
    let stockCount = 0;
    let errorMessage = "";

    setProgress({ done: 0, total: batches.length });

    for (let i = 0; i < batches.length; i++) {
      const { data, error } = await supabase.rpc("import_devices", {
        rows: batches[i],
        p_clear_existing: i === 0 && clearExisting
      });
      if (error) {
        errorMessage = error.message;
        break;
      }
      devicesCount += data?.devices ?? 0;
      stockCount += data?.stock_rows ?? 0;
      setProgress({ done: i + 1, total: batches.length });
    }

    setImporting(false);
    setResult({ devicesCount, stockCount, failed: failedCount, total: parsed.length, error: errorMessage });
    refreshExistingCount();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Prietaisų sandėlio importas</h1>
        <p className="mt-1 text-sm text-ink-600/70">
          Įkelkite Excel (.xlsx) su prietaisų sąrašu (Prietaisas, IAN, Kiekis, Lokacija, Komentaras,
          Gamintojas). Tas pats IAN gali kartotis keliose eilutėse (skirtingos lokacijos) — pakartotinis
          importas atnaujina esamą lokacijos kiekį, ne dubliuoja.
        </p>
        {existingCount !== null && (
          <p className="mt-2 text-xs text-ink-600/60">
            Lentelėje šiuo metu: <strong className="text-ink-900">{existingCount}</strong> prietaiso(-ų) modelis(-iai).
          </p>
        )}
      </div>

      <div className="panel p-4 lg:p-5">
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-ink-700/15 py-10 text-center hover:border-signal-orange/40 hover:bg-signal-orange/5">
          <Upload size={24} className="text-ink-600/50" />
          <span className="text-sm font-medium text-ink-800">
            {fileName || "Spustelėkite ir pasirinkite failą (.xlsx, .csv)"}
          </span>
          <span className="text-xs text-ink-600/50">arba vilkite čia</span>
          <input type="file" accept=".xlsx,.csv" className="hidden" onChange={handleFileChange} />
        </label>

        {parseError && (
          <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-signal-red">
            <AlertCircle size={16} /> {parseError}
          </p>
        )}
      </div>

      {sheetRows.length > 0 && (
        <div className="panel space-y-4 p-4 lg:p-5">
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={skipHeader}
              onChange={(e) => setSkipHeader(e.target.checked)}
              className="h-4 w-4 rounded border-ink-700/30 text-signal-orange focus:ring-signal-orange/30"
            />
            Pirma eilutė — antraštė
          </label>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <label className="mb-1 block text-xs font-semibold text-ink-600/70">{f.label}</label>
                <select
                  value={columnMap[f.key] ?? ""}
                  onChange={(e) => setColumnMap((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  className="input-field"
                >
                  <option value="">— Nenaudoti —</option>
                  {Array.from({ length: columnCount }, (_, i) => {
                    const sample = String(sheetRows[0]?.[i] ?? "").slice(0, 30);
                    return (
                      <option key={i} value={i}>
                        Stulpelis {columnLabel(i)} {sample && `— pvz.: "${sample}"`}
                      </option>
                    );
                  })}
                </select>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-4 text-sm text-ink-600/70">
            <span>
              Iš viso eilučių: <strong className="text-ink-900">{parsed.length}</strong>
            </span>
            <span>
              Tinkamų (yra IAN): <strong className="text-signal-teal">{validEntries.length}</strong>
            </span>
            <span>
              Praleista: <strong className="text-signal-red">{failedCount}</strong>
            </span>
          </div>

          {previewRows.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-ink-700/10">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-ink-900/5 bg-ink-900/[0.02] text-xs uppercase tracking-wide text-ink-600/60">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">Prietaisas</th>
                      <th className="px-4 py-2.5 font-semibold">IAN</th>
                      <th className="px-4 py-2.5 font-semibold">Kiekis</th>
                      <th className="px-4 py-2.5 font-semibold">Lokacija</th>
                      <th className="px-4 py-2.5 font-semibold">Komentaras</th>
                      <th className="px-4 py-2.5 font-semibold">Gamintojas</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-900/5">
                    {previewRows.map((row, i) => (
                      <tr key={i} className={!row.ian ? "bg-signal-red/5" : undefined}>
                        <td className="px-4 py-2.5 text-ink-800">{row.name || "—"}</td>
                        <td className="px-4 py-2.5 font-mono font-medium text-ink-900">{row.ian || "—"}</td>
                        <td className="px-4 py-2.5 text-ink-800">{row.quantity}</td>
                        <td className="px-4 py-2.5 text-ink-800">{row.location || "—"}</td>
                        <td className="px-4 py-2.5 text-ink-800">{row.notes || "—"}</td>
                        <td className="px-4 py-2.5 text-ink-800">{row.manufacturer || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="border-t border-ink-900/5 px-4 py-2 text-xs text-ink-600/50">
                Rodoma pirmų {previewRows.length} iš {parsed.length} eilučių peržiūra.
              </p>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-signal-red">
            <input
              type="checkbox"
              checked={clearExisting}
              onChange={(e) => setClearExisting(e.target.checked)}
              className="h-4 w-4 rounded border-ink-700/30 text-signal-red focus:ring-signal-red/30"
            />
            Prieš importuojant ištrinti esamus duomenis ({existingCount ?? 0} prietaiso(-ų))
          </label>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleImport}
              disabled={importing || !validEntries.length}
              className="btn-primary"
            >
              {importing ? <Loader2 size={16} className="animate-spin" /> : <FileSpreadsheet size={16} />}
              Importuoti {validEntries.length > 0 && `(${validEntries.length})`}
            </button>

            {importing && progress && (
              <span className="text-sm text-ink-600/70">
                Apdorojama: {progress.done} / {progress.total} paketų…
              </span>
            )}
          </div>

          {result && (
            <div
              className={`flex items-start gap-2 rounded-xl border p-3.5 text-sm ${
                result.error
                  ? "border-signal-red/20 bg-signal-red/5 text-signal-red"
                  : "border-signal-teal/20 bg-signal-teal/5 text-signal-teal"
              }`}
            >
              {result.error ? <AlertCircle size={16} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={16} className="mt-0.5 shrink-0" />}
              {result.error ? (
                <span>Klaida importuojant: {result.error}</span>
              ) : (
                <span>
                  Importas baigtas. Prietaisų: <strong>{result.devicesCount}</strong>, likučių įrašų:{" "}
                  <strong>{result.stockCount}</strong>, praleista: <strong>{result.failed}</strong> (iš{" "}
                  {result.total} eilučių).
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
