import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  PackageCheck, PackageMinus, Trash2, Loader2, AlertCircle, X, Upload, FileText, RotateCcw
} from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../lib/AuthProvider";
import { readTransferPdfRows } from "../lib/readTransferPdf";

function formatDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("lt-LT");
}

// Rodo, KUR sandėlyje prietaiso šiuo metu yra (dar nepasirinkta konkreti
// lokacija — tai įvyksta tik pažymint "paimta") — padeda greitai susirasti
// nueinant į sandėlį.
function formatLocations(stock) {
  const rows = (stock || []).filter((s) => (s.quantity ?? 0) > 0);
  if (rows.length === 0) return "—";
  return rows.map((s) => `${s.location} (${s.quantity})`).join(", ");
}

// Garantinio serviso srautas: klientas atsiunčia sugedusį prietaisą,
// reikia rasti IR atsinešti iš sandėlio to paties PAVADINIMO pakaitinį
// (IAN dažniausiai skiriasi — kitas fizinis vienetas). Šis sąrašas
// pakeičia buvusį rankinį sekimą Google Sheets ("ką atsinešti") + Excel
// (nurašymo žurnalas).
//
// TRYS atskiri žingsniai/būsenos (žr. migrate_add_device_pickups.sql) —
// fizinis daikto paėmimas iš lentynos ir jo nurašymas iš apskaitos NĖRA
// tas pats momentas:
//   1) Laukia   — dar nepaimta.
//   2) Paimta   — fiziškai paimta (mark_device_picked RPC), device_stock
//                 DAR NEKEIČIAMAS.
//   3) Nurašyta — papildomai paspaudus "Nurašyti" (finalize_device_pickup
//                 RPC) — TIK DABAR sumažinamas device_stock ir sukuriamas
//                 device_writeoffs įrašas (priežastis "garantija").
export default function DevicePickups() {
  const { hasDevicePermission } = useAuth();
  // Pati /prietaisai/atsinesimai route jau reikalauja "edit" teisės
  // (App.jsx) — pridėti/trinti/žymėti "paimta" galima su ja. "Nurašyti"
  // (kiekio atėmimas) papildomai reikalauja "delete" (ta pati teisė, kuri
  // jau naudojama bet kokiam kitam nurašymui).
  const canFinalize = hasDevicePermission("delete");

  const [pending, setPending] = useState([]);
  const [picked, setPicked] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState("");
  const [pickTarget, setPickTarget] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [finalizingId, setFinalizingId] = useState(null);
  const [unpickingId, setUnpickingId] = useState(null);
  const [manufacturerFilter, setManufacturerFilter] = useState("");

  async function load() {
    setLoading(true);
    const [{ data: pendingData }, { data: pickedData }] = await Promise.all([
      supabase
        .from("device_pickups")
        .select("id, device_id, quantity, note, created_at, devices(name, ian, manufacturer, device_stock(location, quantity))")
        .is("picked_at", null)
        .order("created_at", { ascending: true }),
      supabase
        .from("device_pickups")
        .select("id, quantity, note, picked_at, picked_location, writeoff_id, devices(name, ian), profiles!picked_by(username)")
        .not("picked_at", "is", null)
        .order("picked_at", { ascending: false })
        .limit(50)
    ]);
    setPending(pendingData || []);
    setPicked(pickedData || []);
    setLoading(false);
  }

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    load();
    const channel = supabase
      .channel("device-pickups-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "device_pickups" }, () => loadRef.current())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  async function handleDelete(item) {
    if (!confirm(`Ar tikrai norite pašalinti punktą „${item.devices?.name || item.devices?.ian || "—"}“ iš sąrašo?`)) return;
    setDeletingId(item.id);
    const { error } = await supabase.from("device_pickups").delete().eq("id", item.id);
    setDeletingId(null);
    if (error) setActionError(`Nepavyko pašalinti: ${error.message}`);
  }

  // Grąžina klaidos tekstą, jei nepavyko — PickModal tada rodo ją formoje
  // ir NEUŽDARO jos.
  async function handlePick(item, location) {
    const { error } = await supabase.rpc("mark_device_picked", { p_pickup_id: item.id, p_location: location });
    if (error) return error.message;
    setPickTarget(null);
  }

  async function handleFinalize(item) {
    if (!confirm(`Nurašyti „${item.devices?.name || item.devices?.ian || "—"}“ (${item.quantity} vnt.) iš lokacijos ${item.picked_location}?`)) return;
    setFinalizingId(item.id);
    const { error } = await supabase.rpc("finalize_device_pickup", { p_pickup_id: item.id });
    setFinalizingId(null);
    if (error) setActionError(`Nepavyko nurašyti: ${error.message}`);
  }

  // "Atgal" — grąžina klaidingai paimtą (bet dar NENURAŠYTĄ) punktą į
  // "Laukia". Neatšaukiama patvirtinimu, nes veiksmas grįžtamas — tas pats
  // punktas iškart gali būti pažymėtas "Paimta" iš naujo.
  async function handleUnpick(item) {
    setUnpickingId(item.id);
    const { error } = await supabase.rpc("unpick_device_pickup", { p_pickup_id: item.id });
    setUnpickingId(null);
    if (error) setActionError(`Nepavyko grąžinti: ${error.message}`);
  }

  const manufacturerOptions = [...new Set(pending.map((p) => p.devices?.manufacturer).filter(Boolean))].sort();
  const filteredPending = manufacturerFilter
    ? pending.filter((p) => p.devices?.manufacturer === manufacturerFilter)
    : pending;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Atsinešimai</h1>
        <p className="mt-1 text-sm text-ink-600/70">
          Garantinio serviso sąrašas — ką reikia atsinešti iš sandėlio. Punktai pridedami tiesiai iš{" "}
          <Link to="/prietaisai" className="underline decoration-dotted hover:text-ink-900">
            prietaisų sąrašo
          </Link>{" "}
          (mygtukas prie kiekvieno prietaiso). Paėmimas ir nurašymas — du atskiri žingsniai: pažymėjus „paimta"
          kiekis sandėlyje dar NESIKEIČIA, jis sumažinamas tik paspaudus „Nurašyti".
        </p>
      </div>

      {actionError && (
        <div className="flex items-start gap-2 rounded-xl border border-signal-red/20 bg-signal-red/5 p-3.5 text-sm text-signal-red">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span className="flex-1">{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError("")}
            className="shrink-0 rounded-lg p-0.5 hover:bg-signal-red/10"
            aria-label="Uždaryti pranešimą"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {canFinalize && <ImportTransferPanel />}

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-600/50">
            Laukia {filteredPending.length > 0 && `(${filteredPending.length})`}
          </p>
          {manufacturerOptions.length > 0 && (
            <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-ink-600/70">
              Gamintojas
              <select
                value={manufacturerFilter}
                onChange={(e) => setManufacturerFilter(e.target.value)}
                className="input-field w-auto py-1.5 text-sm"
              >
                <option value="">Visi</option>
                {manufacturerOptions.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="panel overflow-hidden p-0">
          {loading ? (
            <div className="flex justify-center py-10 text-ink-600/50">
              <Loader2 className="animate-spin" size={20} />
            </div>
          ) : pending.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <PackageCheck className="text-ink-600/30" size={24} />
              <p className="text-sm text-ink-600/60">Sąrašas tuščias — visi punktai paimti.</p>
            </div>
          ) : filteredPending.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <p className="text-sm text-ink-600/60">Pagal pasirinktą gamintoją nieko nerasta.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-ink-900/5 bg-ink-900/[0.02] text-xs uppercase tracking-wide text-ink-600/60">
                  <tr>
                    <th className="px-3 py-2.5 font-semibold">Prietaisas</th>
                    <th className="px-3 py-2.5 font-semibold">IAN</th>
                    <th className="px-3 py-2.5 font-semibold">Lokacijos</th>
                    <th className="px-3 py-2.5 font-semibold">Kiekis</th>
                    <th className="px-3 py-2.5 font-semibold">Pastaba</th>
                    <th className="px-3 py-2.5 font-semibold">Pridėta</th>
                    <th className="px-3 py-2.5 font-semibold">Gamintojas</th>
                    <th className="w-0 px-3 py-2.5"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-900/5">
                  {filteredPending.map((item) => (
                    <tr key={item.id} className="hover:bg-ink-900/[0.015]">
                      <td
                        className="max-w-[200px] truncate px-3 py-2.5 text-ink-800"
                        title={item.devices?.name || undefined}
                      >
                        {item.devices?.name || "—"}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs text-ink-600/70">{item.devices?.ian || "—"}</td>
                      <td className="max-w-[200px] truncate px-3 py-2.5 text-ink-600/70">
                        {formatLocations(item.devices?.device_stock)}
                      </td>
                      <td className="px-3 py-2.5 font-semibold text-ink-800">{item.quantity}</td>
                      <td
                        className="max-w-[200px] truncate px-3 py-2.5 text-ink-600/70"
                        title={item.note || undefined}
                      >
                        {item.note || "—"}
                      </td>
                      <td className="px-3 py-2.5 text-ink-600/70">{formatDate(item.created_at)}</td>
                      <td className="px-3 py-2.5 text-ink-800">{item.devices?.manufacturer || "—"}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setPickTarget(item)}
                            className="btn-secondary shrink-0 border-signal-teal/30 text-signal-teal hover:bg-signal-teal/10"
                          >
                            <PackageCheck size={14} /> Paimta
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(item)}
                            disabled={deletingId === item.id}
                            className="shrink-0 rounded-lg p-1.5 text-ink-600/40 hover:bg-signal-red/10 hover:text-signal-red"
                            aria-label="Pašalinti punktą"
                          >
                            {deletingId === item.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-600/50">
          Paimta {picked.length > 0 && "(paskutiniai 50)"}
        </p>
        <div className="panel overflow-hidden p-0">
          {!loading && picked.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <p className="text-sm text-ink-600/60">Dar nieko nepaimta.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-ink-900/5 bg-ink-900/[0.02] text-xs uppercase tracking-wide text-ink-600/60">
                  <tr>
                    <th className="px-3 py-2.5 font-semibold">Prietaisas</th>
                    <th className="px-3 py-2.5 font-semibold">Kiekis</th>
                    <th className="px-3 py-2.5 font-semibold">Lokacija</th>
                    <th className="px-3 py-2.5 font-semibold">Pastaba</th>
                    <th className="px-3 py-2.5 font-semibold">Paimta</th>
                    <th className="px-3 py-2.5 font-semibold">Kas</th>
                    <th className="px-3 py-2.5 font-semibold">Būsena</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-900/5">
                  {picked.map((item) => (
                    <tr key={item.id} className="hover:bg-ink-900/[0.015]">
                      <td className="max-w-[220px] truncate px-3 py-2.5 text-ink-800">
                        {item.devices?.name || "—"}{" "}
                        <span className="font-mono text-xs text-ink-600/50">({item.devices?.ian})</span>
                      </td>
                      <td className="px-3 py-2.5 font-semibold text-ink-800">{item.quantity}</td>
                      <td className="px-3 py-2.5 text-ink-800">{item.picked_location || "—"}</td>
                      <td className="max-w-[220px] truncate px-3 py-2.5 text-ink-600/70">{item.note || "—"}</td>
                      <td className="px-3 py-2.5 text-ink-600/70">{formatDate(item.picked_at)}</td>
                      <td className="px-3 py-2.5 text-ink-600/70">{item.profiles?.username || "—"}</td>
                      <td className="px-3 py-2.5">
                        {item.writeoff_id ? (
                          <span className="text-xs font-medium text-ink-600/50">Nurašyta</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            {canFinalize && (
                              <button
                                type="button"
                                onClick={() => handleFinalize(item)}
                                disabled={finalizingId === item.id || unpickingId === item.id}
                                className="btn-secondary shrink-0 border-signal-amber/30 text-signal-amber hover:bg-signal-amber/10"
                              >
                                {finalizingId === item.id ? <Loader2 size={14} className="animate-spin" /> : <PackageMinus size={14} />}
                                Nurašyti
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleUnpick(item)}
                              disabled={unpickingId === item.id || finalizingId === item.id}
                              className="text-xs font-medium text-ink-600/60 underline decoration-dotted hover:text-ink-900 disabled:opacity-50"
                            >
                              {unpickingId === item.id ? "Grąžinama…" : "Atgal"}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {pickTarget && (
        <PickModal
          item={pickTarget}
          onClose={() => setPickTarget(null)}
          onPick={(location) => handlePick(pickTarget, location)}
        />
      )}
    </div>
  );
}

function PickModal({ item, onClose, onPick }) {
  const [locations, setLocations] = useState(null); // null = kraunama
  const [location, setLocation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    supabase
      .from("device_stock")
      .select("location, quantity")
      .eq("device_id", item.device_id)
      .gt("quantity", 0)
      .order("location", { ascending: true })
      .then(({ data }) => {
        if (!active) return;
        const rows = data || [];
        setLocations(rows);
        if (rows.length) setLocation(rows[0].location);
      });
    return () => {
      active = false;
    };
  }, [item.device_id]);

  async function submit(e) {
    e.preventDefault();
    if (!location) {
      setError("Pasirinkite lokaciją.");
      return;
    }
    setSaving(true);
    setError("");
    const errorMessage = await onPick(location);
    setSaving(false);
    if (errorMessage) setError(errorMessage);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink-950/50 p-0 sm:items-center sm:p-4">
      <form onSubmit={submit} className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-panel sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">Pažymėti kaip paimta</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-ink-900/5">
            <X size={18} />
          </button>
        </div>

        <p className="mb-3 text-sm text-ink-600/70">
          {item.devices?.name || item.devices?.ian} — kiekis: <span className="font-semibold text-ink-800">{item.quantity}</span>
        </p>

        {locations === null ? (
          <div className="flex justify-center py-6 text-ink-600/40">
            <Loader2 className="animate-spin" size={18} />
          </div>
        ) : locations.length === 0 ? (
          <p className="flex items-center gap-1.5 text-sm font-medium text-signal-red">
            <AlertCircle size={16} className="shrink-0" /> Šio prietaiso šiuo metu nėra jokioje lokacijoje.
          </p>
        ) : (
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Lokacija</label>
            <select
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="input-field"
              required
            >
              {locations.map((s) => (
                <option key={s.location} value={s.location}>
                  Lokacija {s.location} ({s.quantity} vnt.)
                </option>
              ))}
            </select>
          </div>
        )}

        {error && (
          <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-signal-red">
            <AlertCircle size={16} className="shrink-0" /> {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Atšaukti
          </button>
          <button type="submit" disabled={saving || !locations?.length} className="btn-primary">
            {saving && <Loader2 size={15} className="animate-spin" />}
            Patvirtinti
          </button>
        </div>
      </form>
    </div>
  );
}

const STATUS_LABEL = {
  match: "Bus nurašyta",
  done: "Nurašyta",
  error: "Klaida",
  ian_not_found: "IAN nerastas sistemoje",
  no_pending_pickup: "Nerastas „Paimta“ punktas",
  quantity_mismatch: "Kiekis nesutampa",
  ambiguous: "Keli galimi punktai"
};

function statusDetail(row) {
  if (row.status === "error") return `Klaida: ${row.errorMessage}`;
  if (row.status === "quantity_mismatch") return `Kiekis nesutampa (PDF: ${row.quantity}, sąraše: ${row.listQuantity})`;
  if (row.status === "no_pending_pickup") return "Nerastas „Paimta“ punktas šiam prietaisui — pridėkite/pažymėkite rankiniu būdu.";
  if (row.status === "ambiguous") return "Keli galimi „Paimta“ punktai — reikia rankinio veiksmo.";
  return STATUS_LABEL[row.status] || row.status;
}

function statusTone(status) {
  if (status === "match" || status === "done") return "text-signal-teal";
  if (status === "error" || status === "ian_not_found") return "text-signal-red";
  return "text-signal-amber";
}

// Kiekvienai PDF eilutei suranda prietaisą pagal IAN, o tada — TIKSLIAI
// vieną atitinkamą "Paimta, dar nenurašyta" device_pickups punktą su tuo
// pačiu kiekiu. Nieko nespėja/nekuria — jei atitikmuo nevienareikšmis,
// eilutė tiesiog pažymima kaip reikalaujanti rankinio veiksmo (žr.
// statusDetail() aukščiau).
async function matchTransferRows(rows) {
  const results = [];
  for (const row of rows) {
    const { data: device } = await supabase
      .from("devices")
      .select("id, name, ian")
      .eq("ian", row.ian)
      .maybeSingle();

    if (!device) {
      results.push({ ...row, status: "ian_not_found" });
      continue;
    }

    const { data: candidates } = await supabase
      .from("device_pickups")
      .select("id, quantity")
      .eq("device_id", device.id)
      .not("picked_at", "is", null)
      .is("writeoff_id", null);

    const list = candidates || [];
    if (list.length === 0) {
      results.push({ ...row, status: "no_pending_pickup", deviceName: device.name });
    } else if (list.length > 1) {
      results.push({ ...row, status: "ambiguous", deviceName: device.name });
    } else if (list[0].quantity !== row.quantity) {
      results.push({
        ...row,
        status: "quantity_mismatch",
        deviceName: device.name,
        listQuantity: list[0].quantity,
        pickupId: list[0].id
      });
    } else {
      results.push({ ...row, status: "match", deviceName: device.name, pickupId: list[0].id });
    }
  }
  return results;
}

// PDF importas iš vidinės (be API) sistemos — "Internal transfer" pažyma,
// kurią Marius vis tiek turi sugeneruoti toje sistemoje rankiniu būdu.
// Vietoj to, kad po to dar kartą klikinėtų "Nurašyti" per kiekvieną
// punktą čia, įkelia tą patį PDF — sistema automatiškai nurašo TIK
// vienareikšmiškai atpažintus punktus, o visa kita palieka peržiūrai (žr.
// matchTransferRows()).
function ImportTransferPanel() {
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState(null); // null = failas dar nepasirinktas
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState("");
  const [running, setRunning] = useState(false);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setParseError("");
    setRows(null);
    setParsing(true);
    try {
      const parsed = await readTransferPdfRows(file);
      if (parsed.length === 0) {
        setParseError("Nepavyko rasti nė vienos eilutės šiame PDF faile.");
      } else {
        setRows(await matchTransferRows(parsed));
      }
    } catch (err) {
      setParseError(`Nepavyko nuskaityti PDF: ${err.message}`);
    }
    setParsing(false);
  }

  async function handleRun() {
    setRunning(true);
    const next = [...rows];
    for (let i = 0; i < next.length; i++) {
      if (next[i].status !== "match") continue;
      const { error } = await supabase.rpc("finalize_device_pickup", { p_pickup_id: next[i].pickupId });
      next[i] = { ...next[i], status: error ? "error" : "done", errorMessage: error?.message };
      setRows([...next]);
    }
    setRunning(false);
  }

  function reset() {
    setFileName("");
    setRows(null);
    setParseError("");
  }

  const matchCount = rows?.filter((r) => r.status === "match").length ?? 0;
  const doneCount = rows?.filter((r) => r.status === "done").length ?? 0;
  const finished = rows && rows.every((r) => r.status !== "match");

  return (
    <div className="panel p-4 lg:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink-900">Importas iš vidinės sistemos (PDF)</p>
        {(rows || parseError) && (
          <button
            type="button"
            onClick={reset}
            className="flex shrink-0 items-center gap-1 text-xs font-medium text-ink-600/60 hover:text-ink-900"
          >
            <RotateCcw size={12} /> Naujas importas
          </button>
        )}
      </div>

      {!rows && !parseError && !parsing && (
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-ink-700/15 py-8 text-center hover:border-signal-orange/40 hover:bg-signal-orange/5">
          <Upload size={22} className="text-ink-600/50" />
          <span className="text-sm font-medium text-ink-800">
            {fileName || "Spustelėkite ir pasirinkite vidinės sistemos PDF (perkėlimo pažymą)"}
          </span>
          <input type="file" accept=".pdf" className="hidden" onChange={handleFile} />
        </label>
      )}

      {parsing && (
        <div className="flex items-center justify-center gap-2 py-8 text-ink-600/50">
          <Loader2 size={18} className="animate-spin" /> Nuskaitoma…
        </div>
      )}

      {parseError && (
        <p className="flex items-center gap-1.5 text-sm font-medium text-signal-red">
          <AlertCircle size={16} className="shrink-0" /> {parseError}
        </p>
      )}

      {rows && (
        <div className="space-y-3">
          <p className="flex items-center gap-1.5 text-xs text-ink-600/60">
            <FileText size={13} /> {fileName} — rasta {rows.length} eilučių
          </p>

          <div className="overflow-hidden rounded-xl border border-ink-700/10">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-ink-900/5 bg-ink-900/[0.02] text-xs uppercase tracking-wide text-ink-600/60">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Prietaisas (PDF)</th>
                    <th className="px-4 py-2.5 font-semibold">IAN</th>
                    <th className="px-4 py-2.5 font-semibold">Kiekis</th>
                    <th className="px-4 py-2.5 font-semibold">Būsena</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-900/5">
                  {rows.map((row, i) => (
                    <tr key={i}>
                      <td className="max-w-[200px] truncate px-4 py-2.5 text-ink-800" title={row.name}>
                        {row.deviceName || row.name}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-ink-900">{row.ian}</td>
                      <td className="px-4 py-2.5 text-ink-800">{row.quantity}</td>
                      <td className={`px-4 py-2.5 text-xs font-medium ${statusTone(row.status)}`}>
                        {statusDetail(row)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {finished ? (
            <p className="text-sm text-ink-600/70">
              Importas baigtas — nurašyta <strong className="text-ink-900">{doneCount}</strong> iš {rows.length} eilučių.
              Likusias peržiūrėkite ir sutvarkykite rankiniu būdu.
            </p>
          ) : (
            <div className="flex items-center gap-3">
              <button type="button" onClick={handleRun} disabled={running || matchCount === 0} className="btn-primary">
                {running ? <Loader2 size={15} className="animate-spin" /> : <PackageMinus size={15} />}
                Vykdyti ({matchCount})
              </button>
              <span className="text-xs text-ink-600/60">
                Automatiškai bus nurašyta {matchCount} iš {rows.length} eilučių — likusias reikės sutvarkyti rankiniu būdu.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
