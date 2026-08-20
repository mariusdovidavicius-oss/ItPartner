import { useMemo, useState } from "react";
import { Upload, FileSpreadsheet, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { normalizeHeader, columnLabel } from "../lib/excelHeaders";
import { readSpreadsheetRows } from "../lib/readSpreadsheet";

const BATCH_SIZE = 500;

// Ištraukia IAN kodą iš skliaustelių eilutės gale, pvz.
// "AURS Parkside PARS 7 A1-Service (356413)" -> { ian: "356413", name: "AURS Parkside PARS 7 A1-Service" }
function parseCatalogLine(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ian: null, name: null, raw: text };
  const match = text.match(/^(.*)\((\d+)\)\s*$/);
  if (!match) return { ian: null, name: null, raw: text };
  return { ian: match[2].trim(), name: match[1].trim(), raw: text };
}

export default function CatalogImport() {
  const [fileName, setFileName] = useState("");
  const [sheetRows, setSheetRows] = useState([]); // array-of-arrays, visos eilutės iš failo
  const [columnCount, setColumnCount] = useState(0);
  const [selectedColumn, setSelectedColumn] = useState("");
  const [manufacturerColumn, setManufacturerColumn] = useState(""); // "" = nenaudojama
  const [typeColumn, setTypeColumn] = useState(""); // "" = nenaudojama
  const [skipHeader, setSkipHeader] = useState(true);
  const [parseError, setParseError] = useState("");
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total }
  const [result, setResult] = useState(null); // { added, updated, failed, total }

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError("");
    setResult(null);
    setSelectedColumn("");
    setManufacturerColumn("");
    setTypeColumn("");
    setFileName(file.name);

    try {
      const rows = await readSpreadsheetRows(file);
      const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
      setSheetRows(rows);
      setColumnCount(maxCols);
      if (maxCols > 0) setSelectedColumn("0");

      // Bando atspėti Gamintojo/Tipo stulpelius pagal antraštės tekstą
      const headerRow = rows[0] || [];
      headerRow.forEach((cell, i) => {
        const norm = normalizeHeader(cell);
        if (norm === "gamintojas") setManufacturerColumn(String(i));
        if (norm === "tipas") setTypeColumn(String(i));
      });
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
    if (selectedColumn === "" || !dataRows.length) return [];
    const colIndex = Number(selectedColumn);
    const mIndex = manufacturerColumn !== "" ? Number(manufacturerColumn) : null;
    const tIndex = typeColumn !== "" ? Number(typeColumn) : null;
    return dataRows
      .filter((row) => String(row[colIndex] ?? "").trim() !== "")
      .map((row) => ({
        ...parseCatalogLine(row[colIndex]),
        manufacturer: mIndex !== null ? String(row[mIndex] ?? "").trim() || null : null,
        item_type: tIndex !== null ? String(row[tIndex] ?? "").trim() || null : null
      }));
  }, [dataRows, selectedColumn, manufacturerColumn, typeColumn]);

  const validEntries = useMemo(() => parsed.filter((p) => p.ian), [parsed]);
  const failedCount = parsed.length - validEntries.length;

  const previewRows = parsed.slice(0, 10);

  async function handleImport() {
    if (!validEntries.length) return;
    setImporting(true);
    setResult(null);

    // Dedup pagal IAN failo viduje — paskutinis įrašas laimi.
    // manufacturer/item_type raktai įtraukiami TIK jei atitinkamas stulpelis
    // pasirinktas — taip pakartotinis importas be šių stulpelių neišvalo jau
    // įrašytų reikšmių iki null.
    const byIan = new Map();
    for (const entry of validEntries) {
      const record = { ian: entry.ian, name: entry.name || null, raw_text: entry.raw };
      if (manufacturerColumn !== "") record.manufacturer = entry.manufacturer;
      if (typeColumn !== "") record.item_type = entry.item_type;
      byIan.set(entry.ian, record);
    }
    const uniqueEntries = Array.from(byIan.values());

    const batches = [];
    for (let i = 0; i < uniqueEntries.length; i += BATCH_SIZE) {
      batches.push(uniqueEntries.slice(i, i + BATCH_SIZE));
    }

    let added = 0;
    let updated = 0;
    let errorMessage = "";

    setProgress({ done: 0, total: batches.length });

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const ians = batch.map((b) => b.ian);

      const { data: existing, error: selectError } = await supabase
        .from("catalog")
        .select("ian")
        .in("ian", ians);

      if (selectError) {
        errorMessage = selectError.message;
        break;
      }

      const existingSet = new Set((existing || []).map((r) => r.ian));
      added += batch.filter((b) => !existingSet.has(b.ian)).length;
      updated += batch.filter((b) => existingSet.has(b.ian)).length;

      const { error: upsertError } = await supabase
        .from("catalog")
        .upsert(batch, { onConflict: "ian" });

      if (upsertError) {
        errorMessage = upsertError.message;
        break;
      }

      setProgress({ done: i + 1, total: batches.length });
    }

    setImporting(false);
    setResult({
      added,
      updated,
      failed: failedCount,
      total: parsed.length,
      error: errorMessage
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Katalogo importas</h1>
        <p className="mt-1 text-sm text-ink-600/70">
          Įkelkite Excel (.xlsx) arba CSV failą su etaloniniais IAN kodais ir pavadinimais. Administracinis
          puslapis — nepasiekiamas per naršymo meniu.
        </p>
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
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">
                Stulpelis su tekstu (pvz. „Pavadinimas (IAN)“)
              </label>
              <select
                value={selectedColumn}
                onChange={(e) => setSelectedColumn(e.target.value)}
                className="input-field"
              >
                {Array.from({ length: columnCount }, (_, i) => {
                  const sample = String(sheetRows[0]?.[i] ?? "").slice(0, 40);
                  return (
                    <option key={i} value={i}>
                      Stulpelis {columnLabel(i)} {sample && `— pvz.: "${sample}"`}
                    </option>
                  );
                })}
              </select>
            </div>
            <label className="flex items-center gap-2 pb-2.5 text-sm text-ink-700">
              <input
                type="checkbox"
                checked={skipHeader}
                onChange={(e) => setSkipHeader(e.target.checked)}
                className="h-4 w-4 rounded border-ink-700/30 text-signal-orange focus:ring-signal-orange/30"
              />
              Pirma eilutė — antraštė
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">
                Gamintojo stulpelis (nebūtina)
              </label>
              <select
                value={manufacturerColumn}
                onChange={(e) => setManufacturerColumn(e.target.value)}
                className="input-field"
              >
                <option value="">— Nenaudoti —</option>
                {Array.from({ length: columnCount }, (_, i) => {
                  const sample = String(sheetRows[0]?.[i] ?? "").slice(0, 40);
                  return (
                    <option key={i} value={i}>
                      Stulpelis {columnLabel(i)} {sample && `— pvz.: "${sample}"`}
                    </option>
                  );
                })}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">
                Tipo stulpelis (nebūtina)
              </label>
              <select
                value={typeColumn}
                onChange={(e) => setTypeColumn(e.target.value)}
                className="input-field"
              >
                <option value="">— Nenaudoti —</option>
                {Array.from({ length: columnCount }, (_, i) => {
                  const sample = String(sheetRows[0]?.[i] ?? "").slice(0, 40);
                  return (
                    <option key={i} value={i}>
                      Stulpelis {columnLabel(i)} {sample && `— pvz.: "${sample}"`}
                    </option>
                  );
                })}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap gap-4 text-sm text-ink-600/70">
            <span>
              Iš viso eilučių: <strong className="text-ink-900">{parsed.length}</strong>
            </span>
            <span>
              Aptiktas IAN: <strong className="text-signal-teal">{validEntries.length}</strong>
            </span>
            <span>
              Nepavyko atpažinti: <strong className="text-signal-red">{failedCount}</strong>
            </span>
          </div>

          {previewRows.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-ink-700/10">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-ink-900/5 bg-ink-900/[0.02] text-xs uppercase tracking-wide text-ink-600/60">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">Aptiktas IAN</th>
                      <th className="px-4 py-2.5 font-semibold">Pavadinimas</th>
                      {manufacturerColumn !== "" && (
                        <th className="px-4 py-2.5 font-semibold">Gamintojas</th>
                      )}
                      {typeColumn !== "" && (
                        <th className="px-4 py-2.5 font-semibold">Tipas</th>
                      )}
                      <th className="px-4 py-2.5 font-semibold">Originalus tekstas</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-900/5">
                    {previewRows.map((row, i) => (
                      <tr key={i} className={!row.ian ? "bg-signal-red/5" : undefined}>
                        <td className="px-4 py-2.5 font-mono font-medium text-ink-900">
                          {row.ian || "—"}
                        </td>
                        <td className="px-4 py-2.5 text-ink-800">{row.name || "—"}</td>
                        {manufacturerColumn !== "" && (
                          <td className="px-4 py-2.5 text-ink-800">{row.manufacturer || "—"}</td>
                        )}
                        {typeColumn !== "" && (
                          <td className="px-4 py-2.5 text-ink-800">{row.item_type || "—"}</td>
                        )}
                        <td className="px-4 py-2.5 text-ink-600/60">{row.raw}</td>
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
                  Importas baigtas. Nauji: <strong>{result.added}</strong>, atnaujinti:{" "}
                  <strong>{result.updated}</strong>, nepavyko atpažinti IAN:{" "}
                  <strong>{result.failed}</strong> (iš {result.total} eilučių).
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
