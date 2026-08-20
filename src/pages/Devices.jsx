import { Fragment, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Search, Loader2, Save, Boxes, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Pencil, X,
  PackagePlus, PackageMinus, Trash2, Download, AlertCircle, ImageIcon, ClipboardList
} from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { exportDevicesToExcel } from "../lib/exportExcel";
import { useAuth } from "../lib/AuthProvider";

// Apsaugo nuo netyčinio ILIKE wildcard elgesio, jei paieškos tekste yra % arba _.
function escapeLike(str) {
  return str.replace(/[%_]/g, (c) => `\\${c}`);
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
// Numatytasis mažo likučio slenkstis, kai prietaisas neturi savo
// individualaus "min_quantity" — turi atitikti DB pusės device_totals
// VIEW stock_level fallback reikšmę (žr. migrate_add_device_min_quantity.sql).
const DEFAULT_LOW_STOCK_THRESHOLD = 3;
const SEARCH_DEBOUNCE_MS = 300;

function totalQuantity(device) {
  return (device.device_stock || []).reduce((sum, s) => sum + (s.quantity || 0), 0);
}

// Ta pati logika, kaip device_totals VIEW stock_level (SQL pusėje) —
// skaičiuojama ir front-end pusėje, kad sąrašo eilutės spalva atsinaujintų
// iškart po redagavimo, nelaukiant realtime pranešimo iš VIEW.
function stockLevel(device) {
  const total = totalQuantity(device);
  if (total <= 0) return "out";
  if (total <= (device.min_quantity ?? DEFAULT_LOW_STOCK_THRESHOLD)) return "low";
  return "ok";
}

export default function Devices() {
  const { user, hasDevicePermission } = useAuth();
  const canEdit = hasDevicePermission("edit");
  const canDelete = hasDevicePermission("delete");
  // Pradinė paieška/likučio filtras gali ateiti iš URL (žr. /statistika
  // plytelių nuorodas — pvz. "?likutis=low", "?q=<pavadinimas>") — skaitoma
  // TIK vieną kartą (lazy init), toliau valdoma įprastai per UI.
  const [searchParams] = useSearchParams();

  const [devices, setDevices] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(() => searchParams.get("q") || "");
  const [debouncedSearch, setDebouncedSearch] = useState(() => searchParams.get("q") || "");
  const [manufacturerFilter, setManufacturerFilter] = useState("");
  const [manufacturerOptions, setManufacturerOptions] = useState([]);
  const [stockFilter, setStockFilter] = useState(() => {
    const v = searchParams.get("likutis");
    return v === "low" || v === "out" ? v : "all";
  }); // all | low | out
  const [stockFilterIds, setStockFilterIds] = useState(null); // null = neapribota; kitaip — device_totals.stock_level atitinkančių id sąrašas
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [exporting, setExporting] = useState(false);
  const [editingDevice, setEditingDevice] = useState(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [writeoffTarget, setWriteoffTarget] = useState(null); // nurašomas prietaisas (su device_stock)
  const [pickupTarget, setPickupTarget] = useState(null); // prietaisas, kuriam pridedamas atsinešimo punktas
  const [writeoffHistory, setWriteoffHistory] = useState({}); // device id -> nurašymų sąrašas
  const [loadingHistoryId, setLoadingHistoryId] = useState(null);
  const [undoingId, setUndoingId] = useState(null);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // "devices" lentelė pati neturi stock_level — jis skaičiuojamas
  // device_totals VIEW (sumuojant device_stock per visas lokacijas), tad
  // filtras veikia dviem žingsniais: pirma surandami atitinkantys id, tada
  // pagrindinė užklausa apribojama .in("id", ...). Kol stockFilter !== "all"
  // o šis sąrašas dar nepakrautas (null), load() žemiau tiesiog palaukia —
  // kitaip trumpam blyktelėtų neteisingi (neapriboti) rezultatai.
  useEffect(() => {
    if (stockFilter === "all") {
      setStockFilterIds(null);
      return;
    }
    let active = true;
    supabase.from("device_totals").select("id").eq("stock_level", stockFilter).then(({ data }) => {
      if (active) setStockFilterIds((data || []).map((r) => r.id));
    });
    return () => {
      active = false;
    };
  }, [stockFilter]);

  function buildQuery(opts = {}) {
    let query = supabase.from("devices").select(
      "id, ian, name, manufacturer, notes, min_quantity, device_stock(id, location, quantity)",
      opts.count ? { count: opts.count } : undefined
    );

    const tokens = debouncedSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
    tokens.forEach((token) => {
      const q = escapeLike(token);
      query = query.or(`name.ilike.%${q}%,ian.ilike.%${q}%,manufacturer.ilike.%${q}%`);
    });

    if (manufacturerFilter) query = query.eq("manufacturer", manufacturerFilter);
    if (stockFilter !== "all") query = query.in("id", stockFilterIds || []);

    return query.order("name", { ascending: true });
  }

  async function load() {
    if (stockFilter !== "all" && stockFilterIds === null) return; // dar laukiame stock_level id sąrašo
    setLoading(true);
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, count } = await buildQuery({ count: "exact" }).range(from, to);
    setDevices(data || []);
    setTotalCount(count ?? 0);
    setLoading(false);
  }

  async function loadManufacturerOptions() {
    const { data } = await supabase.from("devices").select("manufacturer").not("manufacturer", "is", null);
    const set = new Set((data || []).map((r) => r.manufacturer).filter(Boolean));
    setManufacturerOptions([...set].sort());
  }

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  const filterKey = `${debouncedSearch}|${manufacturerFilter}|${stockFilter}|${(stockFilterIds || []).join(",")}|${pageSize}`;
  const prevFilterKey = useRef(filterKey);
  useEffect(() => {
    if (filterKey !== prevFilterKey.current) {
      prevFilterKey.current = filterKey;
      if (page !== 0) {
        setPage(0);
        return;
      }
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, page]);

  const expandedIdsRef = useRef(expandedIds);
  useEffect(() => {
    expandedIdsRef.current = expandedIds;
  }, [expandedIds]);

  useEffect(() => {
    loadManufacturerOptions();
    const channel = supabase
      .channel("devices-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, () => {
        loadRef.current();
        loadManufacturerOptions();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "device_stock" }, () => {
        loadRef.current();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "device_writeoffs" }, (payload) => {
        // Perkraunama TIK pasikeitusio prietaiso istorija (jei ji šiuo metu
        // išskleista), ne visų išskleistų eilučių — kitaip vienas nurašymas
        // sukeltų perteklinius užklausas visiems kitiems, nesusijusiems
        // išskleistiems prietaisams.
        const deviceId = payload.new?.device_id ?? payload.old?.device_id;
        if (deviceId && expandedIdsRef.current.has(deviceId)) loadWriteoffHistory(deviceId);
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  useEffect(() => {
    if (page > totalPages - 1) setPage(Math.max(0, totalPages - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalCount, pageSize]);

  function toggleExpand(id) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (canDelete && !(id in writeoffHistory)) loadWriteoffHistory(id);
  }

  async function loadWriteoffHistory(deviceId) {
    setLoadingHistoryId(deviceId);
    const { data } = await supabase
      .from("device_writeoffs")
      .select("id, location, quantity, reason_type, price, rma, reason, created_at, undone_at, profiles!user_id(username)")
      .eq("device_id", deviceId)
      .order("created_at", { ascending: false });
    setWriteoffHistory((prev) => ({ ...prev, [deviceId]: data || [] }));
    setLoadingHistoryId(null);
  }

  async function handleUndoWriteoff(writeoff, deviceId) {
    if (!confirm(`Ar tikrai norite atšaukti šį nurašymą? ${writeoff.quantity} vnt. bus grąžinta į likutį.`)) return;
    setUndoingId(writeoff.id);
    const { error } = await supabase.rpc("undo_device_writeoff", { p_writeoff_id: writeoff.id });
    setUndoingId(null);
    if (error) {
      setActionError(`Nepavyko atšaukti nurašymo: ${error.message}`);
      return;
    }
    loadWriteoffHistory(deviceId);
  }

  // Grąžina klaidos tekstą, jei nepavyko — WriteoffModal tada rodo ją
  // formoje ir NEUŽDARO jos.
  async function handleWriteoff(device, { location, quantity, reasonType, price, rma, reason }) {
    const { error } = await supabase.rpc("writeoff_device", {
      p_device_id: device.id,
      p_location: location,
      p_quantity: quantity,
      p_reason_type: reasonType,
      p_price: price,
      p_rma: rma,
      p_reason: reason
    });
    if (error) return error.message;
    setWriteoffTarget(null);
    loadWriteoffHistory(device.id);
  }

  // Grąžina klaidos tekstą, jei nepavyko — PickupModal tada rodo ją formoje
  // ir NEUŽDARO jos. Prietaisas jau žinomas (paspausta ties konkrečia
  // eilute), tad punktui pridėti nereikia atskiro prietaiso pasirinkimo —
  // skirtingai nuo /prietaisai/atsinesimai puslapio, kuris tik rodo/valdo
  // jau sudarytą sąrašą.
  async function handleAddPickup(device, { quantity, note }) {
    const { error } = await supabase.from("device_pickups").insert({
      device_id: device.id,
      quantity,
      note
    });
    if (error) return error.message;
    setPickupTarget(null);
  }

  async function handleSaveDeviceNotes(deviceId, notes) {
    const { error } = await supabase.from("devices").update({ notes }).eq("id", deviceId);
    if (error) {
      setActionError(`Nepavyko išsaugoti komentaro: ${error.message}`);
      return false;
    }
    return true;
  }

  async function handleSaveEdit(deviceId, form) {
    const { error } = await supabase
      .from("devices")
      .update({
        name: form.name.trim() || null,
        ian: form.ian.trim(),
        manufacturer: form.manufacturer.trim() || null,
        min_quantity: form.min_quantity === "" ? null : Math.max(0, Math.round(Number(form.min_quantity)) || 0)
      })
      .eq("id", deviceId);
    if (error) return error.message;
    setEditingDevice(null);
  }

  async function handleCreateDevice(form) {
    const { error } = await supabase.from("devices").insert({
      name: form.name.trim() || null,
      ian: form.ian.trim(),
      manufacturer: form.manufacturer.trim() || null,
      min_quantity: form.min_quantity === "" ? null : Math.max(0, Math.round(Number(form.min_quantity)) || 0)
    });
    if (error) return error.message;
    setCreating(false);
  }

  async function handleDeleteDevice(device) {
    if (!confirm(`Ar tikrai norite ištrinti „${device.name || device.ian}“ ir visus jo likučius? Šio veiksmo negalima atšaukti.`)) return;
    setDeletingId(device.id);
    const { error } = await supabase.from("devices").delete().eq("id", device.id);
    setDeletingId(null);
    if (error) setActionError(`Nepavyko ištrinti: ${error.message}`);
  }

  async function handleExport() {
    setExporting(true);
    const { data } = await buildQuery();
    await exportDevicesToExcel(data || [], `Prietaisai-${new Date().toISOString().slice(0, 10)}.xlsx`);
    setExporting(false);
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Prietaisai</h1>
        <p className="mt-1 text-sm text-ink-600/70">
          Prietaisų (įrangos) sandėlio paieška ir kiekių pagal lokaciją redagavimas.
        </p>
      </div>

      {!user && (
        <div className="rounded-xl border border-ink-700/10 bg-ink-900/[0.02] px-3.5 py-2.5 text-sm text-ink-600/70">
          Peržiūros režimas — bet kas gali matyti sąrašą. Norėdami redaguoti duomenis ar nurašyti, prisijunkite (viršuje).
        </div>
      )}

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

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-600/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Ieškoti pagal pavadinimą, IAN arba gamintoją…"
            autoComplete="off"
            className="input-field pl-10"
          />
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-ink-600/70">
          Rodyti po
          <select
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            className="input-field w-auto py-1.5 text-sm"
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting || totalCount === 0}
          className="btn-secondary shrink-0"
        >
          {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
          Eksportuoti
        </button>
        {canEdit && (
          <button type="button" onClick={() => setCreating(true)} className="btn-primary shrink-0">
            <PackagePlus size={15} /> Naujas prietaisas
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
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
        <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-ink-600/70">
          Likutis
          <select
            value={stockFilter}
            onChange={(e) => setStockFilter(e.target.value)}
            className="input-field w-auto py-1.5 text-sm"
          >
            <option value="all">Visi</option>
            <option value="low">Mažas likutis</option>
            <option value="out">Tik baigęsis (0)</option>
          </select>
        </label>
        {(manufacturerFilter !== "" || stockFilter !== "all") && (
          <button
            type="button"
            onClick={() => { setManufacturerFilter(""); setStockFilter("all"); }}
            className="text-xs font-medium text-ink-600/60 underline decoration-dotted hover:text-ink-900"
          >
            Išvalyti filtrus
          </button>
        )}
      </div>

      <div className="panel overflow-hidden p-0">
        {loading ? (
          <div className="flex justify-center py-10 text-ink-600/50">
            <Loader2 className="animate-spin" size={20} />
          </div>
        ) : devices.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Boxes className="text-ink-600/30" size={24} />
            <p className="text-sm text-ink-600/60">
              {totalCount === 0 && debouncedSearch.trim() === "" && manufacturerFilter === "" && stockFilter === "all"
                ? "Prietaisų dar nėra — importuokite juos per /prietaisai/importas."
                : "Pagal paiešką nieko nerasta."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-ink-900/5 bg-ink-900/[0.02] text-xs uppercase tracking-wide text-ink-600/60">
                <tr>
                  <th className="w-8 px-2 py-2.5"></th>
                  <th className="px-3 py-2.5 font-semibold">Prietaisas</th>
                  <th className="px-3 py-2.5 font-semibold">IAN</th>
                  <th className="px-3 py-2.5 font-semibold">Iš viso</th>
                  <th className="w-8 px-2 py-2.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-900/5">
                {devices.map((d) => {
                  const expanded = expandedIds.has(d.id);
                  const level = stockLevel(d);
                  const rowTone =
                    level === "out"
                      ? "bg-signal-red/[0.04] hover:bg-signal-red/[0.07]"
                      : level === "low"
                      ? "bg-signal-amber/[0.05] hover:bg-signal-amber/[0.08]"
                      : "hover:bg-ink-900/[0.015]";
                  return (
                    <Fragment key={d.id}>
                      <tr className={expanded ? "bg-ink-900/[0.015]" : rowTone}>
                        <td
                          className={`w-8 border-l-[3px] px-2 py-2.5 ${
                            level === "out"
                              ? "border-signal-red"
                              : level === "low"
                              ? "border-signal-amber"
                              : "border-transparent"
                          }`}
                          title={level === "out" ? "Baigėsi likutis" : level === "low" ? "Mažas likutis" : undefined}
                        >
                          <button
                            type="button"
                            onClick={() => toggleExpand(d.id)}
                            className="rounded-lg p-1 text-ink-600/50 hover:bg-ink-900/5 hover:text-ink-900"
                            aria-label="Peržiūrėti lokacijas"
                          >
                            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                          </button>
                        </td>
                        <td className="max-w-[220px] truncate px-3 py-2.5 text-ink-800">{d.name || "—"}</td>
                        <td className="max-w-[120px] truncate px-3 py-2.5 font-mono text-ink-900">{d.ian}</td>
                        <td className="px-3 py-2.5 font-bold text-ink-900">{totalQuantity(d)}</td>
                        <td className="w-8 px-2 py-2.5">
                          {canEdit && (
                            <button
                              type="button"
                              onClick={() => setPickupTarget(d)}
                              disabled={totalQuantity(d) <= 0}
                              className="rounded-lg p-1 text-ink-600/40 hover:bg-signal-teal/10 hover:text-signal-teal disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-600/40"
                              aria-label="Atsinešti"
                              title={totalQuantity(d) <= 0 ? "Sandėlyje šiuo metu nėra nė vieno" : "Pridėti į atsinešimų sąrašą"}
                            >
                              <ClipboardList size={15} />
                            </button>
                          )}
                        </td>
                      </tr>

                      {expanded && (
                        <tr className="bg-ink-900/[0.015]">
                          <td colSpan={5} className="px-4 py-4">
                            <DeviceDetail
                              device={d}
                              canEdit={canEdit}
                              canDelete={canDelete}
                              deletingId={deletingId}
                              onSaveNotes={(notes) => handleSaveDeviceNotes(d.id, notes)}
                              onEditDevice={() => setEditingDevice(d)}
                              onDeleteDevice={() => handleDeleteDevice(d)}
                              onWriteoffDevice={() => setWriteoffTarget(d)}
                              writeoffHistory={writeoffHistory[d.id] || []}
                              loadingHistory={loadingHistoryId === d.id}
                              undoingId={undoingId}
                              onUndoWriteoff={(w) => handleUndoWriteoff(w, d.id)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!loading && totalCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-ink-600/50">
            Rodoma {page * pageSize + 1}–{Math.min((page + 1) * pageSize, totalCount)} iš {totalCount}
          </p>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="btn-secondary px-2.5 py-1.5"
                aria-label="Ankstesnis puslapis"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="text-xs font-medium text-ink-600/70">{page + 1} / {totalPages}</span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="btn-secondary px-2.5 py-1.5"
                aria-label="Kitas puslapis"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      )}

      {editingDevice && (
        <DeviceFormModal
          title="Redaguoti prietaisą"
          initial={editingDevice}
          onClose={() => setEditingDevice(null)}
          onSave={(form) => handleSaveEdit(editingDevice.id, form)}
        />
      )}

      {creating && (
        <DeviceFormModal
          title="Naujas prietaisas"
          initial={null}
          onClose={() => setCreating(false)}
          onSave={handleCreateDevice}
        />
      )}

      {writeoffTarget && (
        <WriteoffModal
          device={writeoffTarget}
          onClose={() => setWriteoffTarget(null)}
          onSave={(form) => handleWriteoff(writeoffTarget, form)}
        />
      )}

      {pickupTarget && (
        <PickupModal
          device={pickupTarget}
          onClose={() => setPickupTarget(null)}
          onSave={(form) => handleAddPickup(pickupTarget, form)}
        />
      )}
    </div>
  );
}

const WRITEOFF_REASONS = [
  { value: "parduota", label: "Parduota" },
  { value: "remontui", label: "Panaudota remontui" },
  { value: "garantija", label: "Garantinis pakeitimas" },
  { value: "kita", label: "Kita" }
];

function DeviceDetail({
  device, canEdit, canDelete, deletingId, onSaveNotes, onEditDevice, onDeleteDevice,
  onWriteoffDevice, writeoffHistory, loadingHistory, undoingId, onUndoWriteoff
}) {
  const stock = device.device_stock || [];
  const [notesDraft, setNotesDraft] = useState(device.notes || "");
  const [savingNotes, setSavingNotes] = useState(false);
  const notesChanged = notesDraft !== (device.notes || "");

  async function saveNotes() {
    setSavingNotes(true);
    await onSaveNotes(notesDraft.trim() || null);
    setSavingNotes(false);
  }

  return (
    <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
      <div className="flex h-28 w-full flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-ink-700/15 text-ink-600/40 sm:w-40">
        <ImageIcon size={22} />
        <span className="text-[11px]">Nuotrauka (netrukus)</span>
      </div>

      <div className="space-y-3">
        <div>
          <p className="mb-1 text-xs font-semibold text-ink-600/70">Gamintojas</p>
          <p className="text-sm text-ink-800">{device.manufacturer || "—"}</p>
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold text-ink-600/70">Min. likutis</p>
          <p className="text-sm text-ink-800">
            {device.min_quantity != null ? device.min_quantity : `${DEFAULT_LOW_STOCK_THRESHOLD} (numatyta)`}
          </p>
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold text-ink-600/70">Lokacijos</p>
          {stock.length === 0 ? (
            <p className="text-sm text-ink-800">—</p>
          ) : (
            <ul className="space-y-1">
              {stock.map((s) => (
                <li key={s.id}>
                  <p className="text-sm text-ink-800">
                    Lokacija {s.location} ({s.quantity ?? 0} vnt.)
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold text-ink-600/70">Komentaras</p>
          {canEdit ? (
            <div className="flex items-start gap-2">
              <textarea
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                rows={2}
                placeholder="Komentaras apie prietaisą (nebūtina)"
                className="input-field flex-1 resize-none py-2 text-sm"
              />
              <button
                type="button"
                onClick={saveNotes}
                disabled={savingNotes || !notesChanged}
                className="btn-secondary shrink-0 px-2.5 py-2"
                aria-label="Išsaugoti komentarą"
              >
                {savingNotes ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              </button>
            </div>
          ) : (
            <p className="text-sm text-ink-800">{device.notes || "—"}</p>
          )}
        </div>

        {(canEdit || canDelete) && (
          <div className="flex flex-wrap gap-2">
            {canEdit && (
              <button type="button" onClick={onEditDevice} className="btn-secondary">
                <Pencil size={14} /> Redaguoti prietaisą
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                onClick={onWriteoffDevice}
                disabled={totalQuantity(device) <= 0}
                className="btn-secondary border-signal-amber/30 text-signal-amber hover:bg-signal-amber/10"
              >
                <PackageMinus size={14} /> Nurašyti
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                onClick={onDeleteDevice}
                disabled={deletingId === device.id}
                className="btn-secondary border-signal-red/30 text-signal-red hover:bg-signal-red/10"
              >
                {deletingId === device.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                Ištrinti prietaisą
              </button>
            )}
          </div>
        )}

        {canDelete && (
          <div>
            <p className="mb-1 text-xs font-semibold text-ink-600/70">Nurašymų istorija</p>
            {loadingHistory ? (
              <Loader2 size={14} className="animate-spin text-ink-600/40" />
            ) : writeoffHistory.length === 0 ? (
              <p className="text-sm text-ink-600/50">Nurašymų nebuvo.</p>
            ) : (
              <ul className="space-y-1">
                {writeoffHistory.map((w) => (
                  <li
                    key={w.id}
                    className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs ${
                      w.undone_at ? "text-ink-600/40 line-through" : "text-ink-600/70"
                    }`}
                  >
                    <span>
                      <span className="font-semibold text-ink-800">-{w.quantity} vnt.</span>
                      {" · "}
                      Lokacija {w.location}
                      {" · "}
                      {new Date(w.created_at).toLocaleDateString("lt-LT")}
                      {" · "}
                      {WRITEOFF_REASONS.find((r) => r.value === w.reason_type)?.label || w.reason_type}
                      {w.reason_type === "parduota" && w.price != null && ` (${w.price} €)`}
                      {w.reason_type === "remontui" && w.rma && ` (RMA: ${w.rma})`}
                      {(w.reason_type === "kita" || w.reason_type === "garantija") && w.reason && ` (${w.reason})`}
                      {w.profiles?.username && ` · ${w.profiles.username}`}
                      {w.undone_at && " · atšaukta"}
                    </span>
                    {!w.undone_at && (
                      <button
                        type="button"
                        onClick={() => onUndoWriteoff(w)}
                        disabled={undoingId === w.id}
                        className="shrink-0 font-medium text-signal-orange underline decoration-dotted hover:text-signal-orange/80 disabled:opacity-50"
                      >
                        {undoingId === w.id ? "Atšaukiama…" : "Atšaukti"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function WriteoffModal({ device, onClose, onSave }) {
  const locations = (device.device_stock || []).filter((s) => (s.quantity ?? 0) > 0);
  const [location, setLocation] = useState(locations[0]?.location || "");
  const [quantity, setQuantity] = useState("1");
  const [reasonType, setReasonType] = useState("");
  const [price, setPrice] = useState("");
  const [rma, setRma] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const selectedStock = locations.find((s) => s.location === location);

  async function submit(e) {
    e.preventDefault();
    if (!location) {
      setError("Pasirinkite lokaciją.");
      return;
    }
    const value = Math.round(Number(quantity));
    if (!value || value <= 0) {
      setError("Įveskite teigiamą kiekį.");
      return;
    }
    if (value > (selectedStock?.quantity ?? 0)) {
      setError(`Negalima nurašyti daugiau nei turima likutyje (${selectedStock?.quantity ?? 0}).`);
      return;
    }
    if (!reasonType) {
      setError("Pasirinkite priežastį.");
      return;
    }
    if (reasonType === "parduota" && (!price || Number(price) <= 0)) {
      setError("Įveskite kainą.");
      return;
    }
    if (reasonType === "remontui" && !rma.trim()) {
      setError("Įveskite RMA numerį.");
      return;
    }
    if (reasonType === "kita" && !reason.trim()) {
      setError("Įveskite priežastį.");
      return;
    }

    setSaving(true);
    setError("");
    const errorMessage = await onSave({
      location,
      quantity: value,
      reasonType,
      price: reasonType === "parduota" ? Number(price) : null,
      rma: reasonType === "remontui" ? rma.trim() : null,
      reason: reasonType === "kita" || reasonType === "garantija" ? reason.trim() : null
    });
    setSaving(false);
    if (errorMessage) setError(errorMessage);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink-950/50 p-0 sm:items-center sm:p-4">
      <form
        onSubmit={submit}
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-panel sm:rounded-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">Nurašyti prietaisą</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-ink-900/5">
            <X size={18} />
          </button>
        </div>

        <p className="mb-3 text-sm text-ink-600/70">
          {device.name || device.ian}
        </p>

        <div className="space-y-3">
          {locations.length === 0 ? (
            <p className="flex items-center gap-1.5 text-sm font-medium text-signal-red">
              <AlertCircle size={16} className="shrink-0" /> Nėra lokacijos su likučiu — nėra ko nurašyti.
            </p>
          ) : (
            <>
              <div>
                <label className="mb-1 block text-xs font-semibold text-ink-600/70">Lokacija</label>
                <select
                  value={location}
                  onChange={(e) => { setLocation(e.target.value); setQuantity("1"); }}
                  className="input-field"
                  required
                >
                  {locations.map((s) => (
                    <option key={s.id} value={s.location}>
                      Lokacija {s.location} ({s.quantity ?? 0} vnt.)
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-ink-600/70">Nurašomas kiekis</label>
                <input
                  type="number"
                  min={1}
                  max={selectedStock?.quantity ?? 0}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="input-field"
                  autoFocus
                  required
                />
              </div>
            </>
          )}
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Priežastis</label>
            <select
              value={reasonType}
              onChange={(e) => setReasonType(e.target.value)}
              className="input-field"
              required
            >
              <option value="" disabled>Pasirinkite…</option>
              {WRITEOFF_REASONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>

          {reasonType === "parduota" && (
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">Kaina (€)</label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="input-field"
                required
              />
            </div>
          )}

          {reasonType === "remontui" && (
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">RMA numeris</label>
              <input
                value={rma}
                onChange={(e) => setRma(e.target.value)}
                className="input-field"
                required
              />
            </div>
          )}

          {reasonType === "kita" && (
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">Priežastis</label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                className="input-field resize-none"
                required
              />
            </div>
          )}

          {reasonType === "garantija" && (
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pastaba (nebūtina)</label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="Pvz. kliento grąžinto prietaiso IAN arba užsakymo Nr."
                className="input-field resize-none"
              />
            </div>
          )}
        </div>

        {error && (
          <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-signal-red">
            <AlertCircle size={16} className="shrink-0" /> {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Atšaukti
          </button>
          <button type="submit" disabled={saving || locations.length === 0} className="btn-primary">
            {saving && <Loader2 size={15} className="animate-spin" />}
            Nurašyti
          </button>
        </div>
      </form>
    </div>
  );
}

function PickupModal({ device, onClose, onSave }) {
  const [quantity, setQuantity] = useState("1");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    const value = Math.round(Number(quantity));
    if (!value || value <= 0) {
      setError("Įveskite teigiamą kiekį.");
      return;
    }

    setSaving(true);
    setError("");
    const errorMessage = await onSave({ quantity: value, note: note.trim() || null });
    setSaving(false);
    if (errorMessage) setError(errorMessage);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink-950/50 p-0 sm:items-center sm:p-4">
      <form onSubmit={submit} className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-panel sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">Atsinešti</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-ink-900/5">
            <X size={18} />
          </button>
        </div>

        <p className="mb-3 text-sm text-ink-600/70">{device.name || device.ian}</p>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Kiekis</label>
            <input
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="input-field"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pastaba (nebūtina)</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Pvz. kliento grąžinto prietaiso IAN arba užsakymo Nr."
              className="input-field resize-none"
            />
          </div>
        </div>

        {error && (
          <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-signal-red">
            <AlertCircle size={16} className="shrink-0" /> {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Atšaukti
          </button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving && <Loader2 size={15} className="animate-spin" />}
            Pridėti į sąrašą
          </button>
        </div>
      </form>
    </div>
  );
}

function DeviceFormModal({ title, initial, onClose, onSave }) {
  const [form, setForm] = useState({
    name: initial?.name || "",
    ian: initial?.ian || "",
    manufacturer: initial?.manufacturer || "",
    min_quantity: initial?.min_quantity ?? ""
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const errorMessage = await onSave(form);
    setSaving(false);
    if (errorMessage) setError(errorMessage);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink-950/50 p-0 sm:items-center sm:p-4">
      <form onSubmit={submit} className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-panel sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-ink-900/5">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pavadinimas</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="input-field"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">IAN</label>
            <input
              value={form.ian}
              onChange={(e) => setForm({ ...form, ian: e.target.value })}
              className="input-field font-mono"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Gamintojas</label>
            <input
              value={form.manufacturer}
              onChange={(e) => setForm({ ...form, manufacturer: e.target.value })}
              list="manufacturer-suggestions"
              className="input-field"
            />
            <datalist id="manufacturer-suggestions">
              <option value="Grizzly" />
              <option value="Kompernass" />
            </datalist>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Min. likutis</label>
            <input
              type="number"
              min={0}
              value={form.min_quantity}
              onChange={(e) => setForm({ ...form, min_quantity: e.target.value })}
              placeholder={`Numatyta — ${DEFAULT_LOW_STOCK_THRESHOLD}`}
              className="input-field"
            />
          </div>
        </div>

        {error && (
          <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-signal-red">
            <AlertCircle size={16} className="shrink-0" /> {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Atšaukti
          </button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving && <Loader2 size={15} className="animate-spin" />}
            Išsaugoti
          </button>
        </div>
      </form>
    </div>
  );
}
