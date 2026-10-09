import { useEffect, useMemo, useState } from "react";
import { Upload, FileSpreadsheet, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { normalizeHeader, columnLabel } from "../lib/excelHeaders";
import { partIdent } from "../lib/partIdent";
import { readSpreadsheetRows } from "../lib/readSpreadsheet";

const BATCH_SIZE = 500;

// Tikslinis parts stulpelis -> antraščių tekstai (normalizuoti), pagal kuriuos
// bandoma automatiškai atspėti atitinkamą Excel stulpelį.
const FIELDS = [
  // Sandėlis — nebūtinas stulpelis: jei nenaudojamas (arba langelis tuščias),
  // eilutei priskiriamas puslapyje pasirinktas numatytasis sandėlis.
  { key: "warehouse", label: "Sandėlis", match: ["sandelis", "sandėlis", "warehouse"] },
  { key: "location", label: "Lokacija", match: ["lokacija"] },
  { key: "main_model", label: "Pagrindinis Modelis", match: ["pagrindinis modelis"] },
  { key: "part_code", label: "Detalės Kodas", match: ["detales kodas"] },
  { key: "name", label: "Pavadinimas", match: ["pavadinimas"] },
  { key: "quantity", label: "Kiekis", match: ["kiekis"] },
  { key: "online_store", label: "El. parduotuvė", match: ["el. parduotuve", "el parduotuve"] },
  { key: "compatible_models", label: "Suderinami Modeliai", match: ["suderinami modeliai"] }
];

// Excel eilutė (raw reikšmės pagal stulpelio indeksą) -> tipizuotas parts įrašas.
// defaultWarehouse — numatytojo sandėlio pavadinimas, naudojamas, kai eilutė
// pati sandėlio nenurodo.
function toRecord(row, columnMap, defaultWarehouse) {
  function cell(key) {
    const idx = columnMap[key];
    return idx === "" || idx === undefined ? "" : row[Number(idx)];
  }
  const location = String(cell("location") ?? "").trim() || null;
  const part_code = String(cell("part_code") ?? "").trim();
  const quantityRaw = String(cell("quantity") ?? "").trim();
  const quantity = quantityRaw ? Number(quantityRaw) : 0;

  const record = {
    warehouse: String(cell("warehouse") ?? "").trim() || defaultWarehouse,
    location,
    main_model: String(cell("main_model") ?? "").trim() || null,
    part_code,
    name: String(cell("name") ?? "").trim() || null,
    quantity: Number.isFinite(quantity) ? quantity : 0,
    compatible_models: String(cell("compatible_models") ?? "").trim() || null
  };
  // online_store siunčiamas TIK kai stulpelis susietas — kitaip import_parts()
  // esamų priedų "El. parduotuvė" reikšmės neperrašo į NE.
  if (columnMap.online_store !== "" && columnMap.online_store !== undefined) {
    record.online_store = String(cell("online_store") ?? "").trim().toUpperCase() === "TAIP";
  }
  return record;
}

// Tas pats priedas (partIdent — kodas, o be numerio "N/A" — pavadinimas +
// modelis) tame pačiame sandėlyje + lokacijoje (be tarpų kraštuose,
// neatsižvelgiant į raidžių dydį — kaip part_stock unikalumas) sujungiamas į
// vieną eilutę, kiekiai sudedami. Daroma per VISĄ failą, nes import_parts()
// siunčiamas dalimis ir kitaip vėlesnė dalis perrašytų ankstesnės kiekį.
function mergeDuplicates(entries) {
  const map = new Map();
  entries.forEach((p) => {
    const key = [p.warehouse.trim().toLowerCase(), p.location.trim().toLowerCase(), partIdent(p.part_code, p.name, p.main_model)].join("\u0000");
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...p });
      return;
    }
    prev.quantity += p.quantity;
    prev.main_model = prev.main_model || p.main_model;
    prev.name = prev.name || p.name;
    prev.compatible_models = prev.compatible_models || p.compatible_models;
    if ("online_store" in p) prev.online_store = prev.online_store || p.online_store;
  });
  return [...map.values()];
}

export default function PartsImport() {
  const [fileName, setFileName] = useState("");
  const [sheetRows, setSheetRows] = useState([]); // array-of-arrays, visos eilutės iš failo
  const [columnCount, setColumnCount] = useState(0);
  const [columnMap, setColumnMap] = useState({}); // field key -> stulpelio indeksas (string) arba ""
  const [skipHeader, setSkipHeader] = useState(true);
  const [parseError, setParseError] = useState("");
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total }
  const [result, setResult] = useState(null); // { inserted, failed, total, error }
  const [existingCount, setExistingCount] = useState(null);
  const [clearExisting, setClearExisting] = useState(false);
  // Sandėlis PRIVALO jau egzistuoti (sukurtas /sandeliai puslapyje) —
  // import_parts() jo nekuria, eilutė su nerastu sandėliu praleidžiama.
  // null = dar kraunama / nepavyko įkelti — tada nė viena eilutė nelaikoma
  // tinkama (ta pati logika kaip DevicesImport.jsx).
  const [warehouses, setWarehouses] = useState(null);
  const [warehouseLoadError, setWarehouseLoadError] = useState(false);
  const [defaultWarehouseId, setDefaultWarehouseId] = useState("");

  async function loadWarehouses() {
    setWarehouseLoadError(false);
    const { data, error } = await supabase.from("warehouses").select("id, name").order("name");
    if (error) {
      setWarehouseLoadError(true);
      return;
    }
    const list = data || [];
    setWarehouses(list);
    // Numatytai — "Lidl servisas" (priedų sandėlis), jei yra, kitaip pirmas.
    const lidl = list.find((w) => w.name.trim().toLowerCase() === "lidl servisas");
    setDefaultWarehouseId((prev) => prev || (lidl ?? list[0])?.id || "");
  }

  useEffect(() => {
    refreshExistingCount();
    loadWarehouses();
  }, []);

  // Mažosiomis raidėmis -> sandėlis; atitinka import_parts() lt_lower() palyginimą.
  const warehouseByName = useMemo(
    () => (warehouses ? new Map(warehouses.map((w) => [w.name.trim().toLowerCase(), w])) : null),
    [warehouses]
  );
  const defaultWarehouseName = warehouses?.find((w) => w.id === defaultWarehouseId)?.name || "";

  async function refreshExistingCount() {
    const { count } = await supabase.from("parts").select("*", { count: "exact", head: true });
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

      // Bando automatiškai atpažinti visus 7 stulpelius pagal antraštės tekstą
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
      .map((row) => toRecord(row, columnMap, defaultWarehouseName));
  }, [dataRows, columnMap, defaultWarehouseName]);

  // Priedas turi būti atpažįstamas — kodas arba (be numerio) pavadinimas.
  function rowIdentOk(p) {
    return partIdent(p.part_code, p.name, p.main_model) !== null;
  }

  function rowWarehouseOk(p) {
    return !!(p.warehouse && warehouseByName?.has(p.warehouse.toLowerCase()));
  }

  const validEntries = useMemo(
    () => (warehouseByName ? parsed.filter((p) => rowIdentOk(p) && p.location !== null && rowWarehouseOk(p)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parsed, warehouseByName]
  );
  // Sandėliai, kurių priedai bus išvalyti pažymėjus "ištrinti esamus" —
  // TIK tie, į kuriuos šis importas rašo, ne visi.
  const importWarehouses = useMemo(() => {
    const map = new Map();
    validEntries.forEach((p) => {
      const w = warehouseByName.get(p.warehouse.toLowerCase());
      map.set(w.id, w);
    });
    return [...map.values()];
  }, [validEntries, warehouseByName]);
  const failedCount = parsed.length - validEntries.length;
  const mergedEntries = useMemo(() => mergeDuplicates(validEntries), [validEntries]);
  const mergedCount = validEntries.length - mergedEntries.length;

  const previewRows = parsed.slice(0, 10);

  // Importas eina per import_parts() RPC (SECURITY DEFINER), ne tiesiogiai
  // per .insert()/.delete() — taip 'import' teisė lieka atskira nuo
  // 'edit'/'delete', patikrinama pačioje DB funkcijoje.
  async function handleImport() {
    if (!mergedEntries.length) return;
    setImporting(true);
    setResult(null);

    const batches = [];
    for (let i = 0; i < mergedEntries.length; i += BATCH_SIZE) {
      batches.push(mergedEntries.slice(i, i + BATCH_SIZE));
    }

    let inserted = 0;
    let updated = 0;
    let partsCreated = 0;
    let errorMessage = "";

    setProgress({ done: 0, total: batches.length });

    for (let i = 0; i < batches.length; i++) {
      const { data, error } = await supabase.rpc("import_parts", {
        rows: batches[i],
        clear_existing: i === 0 && clearExisting,
        p_clear_warehouse_ids: importWarehouses.map((w) => w.id)
      });
      if (error) {
        errorMessage = error.message;
        break;
      }
      inserted += data?.inserted ?? 0;
      updated += data?.updated ?? 0;
      partsCreated += data?.parts_created ?? 0;
      setProgress({ done: i + 1, total: batches.length });
    }

    setImporting(false);
    setResult({ inserted, updated, partsCreated, merged: mergedCount, failed: failedCount, total: parsed.length, error: errorMessage });
    refreshExistingCount();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Priedų sandėlio importas</h1>
        <p className="mt-1 text-sm text-ink-600/70">
          Įkelkite Excel (.xlsx) su priedų sąrašu (Lokacija, Pagrindinis Modelis, Detalės Kodas,
          Pavadinimas, Kiekis, El. parduotuvė, Suderinami Modeliai, nebūtinai Sandėlis). Eilutės be
          sandėlio stulpelio keliauja į žemiau pasirinktą numatytąjį sandėlį.
        </p>
        {warehouseLoadError && (
          <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-signal-red">
            <AlertCircle size={14} className="shrink-0" />
            Nepavyko įkelti sandėlių sąrašo — kol nepatvirtinta, nė viena eilutė nelaikoma tinkama importui.{" "}
            <button type="button" onClick={loadWarehouses} className="underline decoration-dotted hover:text-signal-red/80">
              Bandyti dar kartą
            </button>
          </p>
        )}
        {warehouses && warehouses.length === 0 && (
          <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-signal-red">
            <AlertCircle size={14} className="shrink-0" />
            Dar nesukurta nė vieno sandėlio — pirma sukurkite bent vieną /sandeliai puslapyje.
          </p>
        )}
        {existingCount !== null && (
          <p className="mt-2 text-xs text-ink-600/60">
            Lentelėje šiuo metu: <strong className="text-ink-900">{existingCount}</strong> eilutė(-ių).
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

          <div className="max-w-sm">
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Numatytasis sandėlis</label>
            <select
              value={defaultWarehouseId}
              onChange={(e) => setDefaultWarehouseId(e.target.value)}
              className="input-field"
              disabled={!warehouses}
            >
              {(warehouses || []).map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-600/50">
              Naudojamas eilutėms, kurios pačios sandėlio nenurodo.
            </p>
          </div>

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
              Tinkamų (yra kodas arba pavadinimas, lokacija ir sandėlis): <strong className="text-signal-teal">{validEntries.length}</strong>
            </span>
            <span>
              Praleista: <strong className="text-signal-red">{failedCount}</strong>
            </span>
            {mergedCount > 0 && (
              <span>
                Sujungta pasikartojančių (tas pats kodas toje pačioje vietoje, kiekiai sudėti):{" "}
                <strong className="text-ink-900">{mergedCount}</strong>
              </span>
            )}
          </div>
          <p className="text-xs text-ink-600/50">
            Priedas atpažįstamas pagal detalės kodą, o be numerio („N/A“) — pagal pavadinimą ir modelį. Jei
            priedas toje pačioje vietoje jau yra, jis neįterpiamas iš naujo, o atnaujinamas: kiekis perrašomas
            failo reikšme. Nauja vieta esamam priedui pridedama prie jo.
          </p>

          {previewRows.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-ink-700/10">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-ink-900/5 bg-ink-900/[0.02] text-xs uppercase tracking-wide text-ink-600/60">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">Sandėlis</th>
                      <th className="px-4 py-2.5 font-semibold">Lokacija</th>
                      <th className="px-4 py-2.5 font-semibold">Modelis</th>
                      <th className="px-4 py-2.5 font-semibold">Kodas</th>
                      <th className="px-4 py-2.5 font-semibold">Pavadinimas</th>
                      <th className="px-4 py-2.5 font-semibold">Kiekis</th>
                      <th className="px-4 py-2.5 font-semibold">El. parduotuvė</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-900/5">
                    {previewRows.map((row, i) => (
                      <tr key={i} className={!rowIdentOk(row) || row.location === null || (warehouseByName && !rowWarehouseOk(row)) ? "bg-signal-red/5" : undefined}>
                        <td className={`px-4 py-2.5 ${!warehouseByName || rowWarehouseOk(row) ? "text-ink-800" : "font-medium text-signal-red"}`}>
                          {row.warehouse || "— nenurodyta"}
                        </td>
                        <td className="px-4 py-2.5 text-ink-800">{row.location ?? "—"}</td>
                        <td className="px-4 py-2.5 text-ink-800">{row.main_model || "—"}</td>
                        <td className="px-4 py-2.5 font-mono font-medium text-ink-900">{row.part_code || "—"}</td>
                        <td className="px-4 py-2.5 text-ink-800">{row.name || "—"}</td>
                        <td className="px-4 py-2.5 text-ink-800">{row.quantity}</td>
                        <td className="px-4 py-2.5 text-ink-800">{row.online_store ? "TAIP" : "NE"}</td>
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
            Prieš importuojant išvalyti esamas priedų vietas sandėlyje(-iuose):{" "}
            {importWarehouses.length ? importWarehouses.map((w) => w.name).join(", ") : "—"} (kitų sandėlių vietos
            neliečiamos; priedai, kuriems neliks jokios vietos ir kurie neturi nurašymų istorijos, ištrinami)
          </label>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleImport}
              disabled={importing || !mergedEntries.length}
              className="btn-primary"
            >
              {importing ? <Loader2 size={16} className="animate-spin" /> : <FileSpreadsheet size={16} />}
              Importuoti {mergedEntries.length > 0 && `(${mergedEntries.length})`}
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
                  Importas baigtas. Naujų priedų: <strong>{result.partsCreated}</strong>, naujų vietų:{" "}
                  <strong>{result.inserted}</strong>, atnaujinta esamų vietų: <strong>{result.updated}</strong>
                  {result.merged > 0 && <>, sujungta pasikartojančių: <strong>{result.merged}</strong></>}
                  , praleista: <strong>{result.failed}</strong> (iš {result.total} eilučių).
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
