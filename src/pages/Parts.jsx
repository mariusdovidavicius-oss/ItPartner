import { Fragment, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Search, Loader2, Save, Boxes, Minus, Plus, ChevronLeft, ChevronRight,
  ChevronDown, ChevronUp, ImageIcon, Pencil, X, PackagePlus, PackageMinus, Trash2, Download, AlertCircle
} from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { exportPartsToExcel } from "../lib/exportExcel";
import { useAuth } from "../lib/AuthProvider";

// Apsaugo nuo netyčinio ILIKE wildcard elgesio, jei paieškos tekste yra % arba _.
function escapeLike(str) {
  return str.replace(/[%_]/g, (c) => `\\${c}`);
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
// Numatytasis mažo likučio slenkstis, kai priedas neturi savo individualaus
// "min_quantity" — turi atitikti DB pusės "stock_level" generuojamo
// stulpelio fallback reikšmę (žr. migrate_parts_min_quantity.sql).
const DEFAULT_LOW_STOCK_THRESHOLD = 3;
const SEARCH_DEBOUNCE_MS = 300;

export default function Parts() {
  const { user, hasPermission } = useAuth();
  const canEdit = hasPermission("edit");
  const canDelete = hasPermission("delete");
  // Pradinė paieška/likučio filtras gali ateiti iš URL (žr. /statistika
  // plytelių nuorodas — pvz. "?likutis=low", "?q=<pavadinimas>") — skaitoma
  // TIK vieną kartą (lazy init), toliau valdoma įprastai per UI.
  const [searchParams] = useSearchParams();
  const [parts, setParts] = useState([]); // dabartinio puslapio įrašai (paieška/filtrai/puslapiavimas — serverio pusėje)
  const [totalCount, setTotalCount] = useState(0); // dabartinį filtrą atitinkančių įrašų skaičius (iš DB)
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(() => searchParams.get("q") || ""); // rodoma įvesties reikšmė
  const [debouncedSearch, setDebouncedSearch] = useState(() => searchParams.get("q") || ""); // naudojama užklausai, atnaujinama su vėlinimu
  const [quantityDrafts, setQuantityDrafts] = useState({}); // part id -> juodraštis (nekeičiamas realtime reload metu, kad neišsivalytų nebaigtas redagavimas)
  const [savingId, setSavingId] = useState(null);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState(new Set()); // part id -> eilutė išskleista (foto vieta, pilnas suderinamų modelių tekstas, pastaba, redagavimas)
  const [notesDrafts, setNotesDrafts] = useState({}); // part id -> pastabos juodraštis
  const [savingNotesId, setSavingNotesId] = useState(null);
  const [editingPart, setEditingPart] = useState(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [writeoffPart, setWriteoffPart] = useState(null);
  const [writeoffHistory, setWriteoffHistory] = useState({}); // part id -> nurašymų sąrašas
  const [loadingHistoryId, setLoadingHistoryId] = useState(null);
  const [undoingId, setUndoingId] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [locationFilter, setLocationFilter] = useState(""); // "" = visos lokacijos
  const [stockFilter, setStockFilter] = useState(() => {
    const v = searchParams.get("likutis");
    return v === "low" || v === "out" ? v : "all";
  }); // all | low | out
  const [locationOptions, setLocationOptions] = useState([]);
  const [actionError, setActionError] = useState("");

  // Paieškos tekstą debounce'iname, kad serverio užklausa nebūtų siunčiama
  // kas klavišo paspaudimą.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // Bendra užklausos "kurpimo" funkcija — naudojama ir puslapio įkėlimui
  // (su .range()), ir Excel eksportui (be .range(), visi filtrą atitinkantys
  // įrašai), kad paieška/filtrai neišsiskirtų tarp dviejų vietų.
  function buildQuery(opts = {}) {
    let query = supabase.from("parts").select(
      "id, location, main_model, part_code, name, quantity, min_quantity, stock_level, online_store, compatible_models, notes",
      opts.count ? { count: opts.count } : undefined
    );

    const tokens = debouncedSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
    tokens.forEach((token) => {
      const q = escapeLike(token);
      query = query.or(
        `part_code.ilike.%${q}%,name.ilike.%${q}%,main_model.ilike.%${q}%,compatible_models.ilike.%${q}%`
      );
    });

    if (locationFilter !== "") query = query.eq("location", Number(locationFilter));
    if (stockFilter === "out") query = query.eq("stock_level", "out");
    if (stockFilter === "low") query = query.eq("stock_level", "low");

    return query.order("location", { ascending: true });
  }

  async function load() {
    setLoading(true);
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, count } = await buildQuery({ count: "exact" }).range(from, to);

    const list = data || [];
    setParts(list);
    setTotalCount(count ?? 0);

    setQuantityDrafts((prev) => {
      const next = {};
      list.forEach((p) => {
        next[p.id] = p.id in prev ? prev[p.id] : String(p.quantity ?? 0);
      });
      return next;
    });

    setNotesDrafts((prev) => {
      const next = {};
      list.forEach((p) => {
        next[p.id] = p.id in prev ? prev[p.id] : (p.notes || "");
      });
      return next;
    });

    setLoading(false);
  }

  async function loadLocationOptions() {
    const { data } = await supabase.from("parts").select("location").not("location", "is", null);
    const set = new Set((data || []).map((r) => r.location));
    setLocationOptions([...set].sort((a, b) => a - b));
  }

  // load() naudoja debouncedSearch/locationFilter/stockFilter/page/pageSize
  // per closure — realtime pranešimas žemiau visada turi kviesti NAUJAUSIĄ
  // versiją (per loadRef), kitaip liktų prisirišęs prie pirmo render'io metu
  // buvusių filtrų reikšmių.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  // Filtro pasikeitimas turi grąžinti į 1 puslapį PRIEŠ pakraunant — jei tai
  // darytume dviejuose atskiruose efektuose (vienas resetina "page", kitas
  // kviečia load()), load() galėtų suveikti su dar PASENUSIA "page" reikšme
  // tame pačiame React commit'e ir nusiųsti užklausą su offset'u už rezultatų
  // ribų (tuščias atsakymas, nors atitikmenų yra). Todėl abu veiksmai
  // sujungti į vieną efektą, sekantį filtrų "parašą" per ref.
  const filterKey = `${debouncedSearch}|${locationFilter}|${stockFilter}|${pageSize}`;
  const prevFilterKey = useRef(filterKey);
  useEffect(() => {
    if (filterKey !== prevFilterKey.current) {
      prevFilterKey.current = filterKey;
      if (page !== 0) {
        setPage(0);
        return; // load() suveiks pakartotinai, kai "page" efektyviai taps 0
      }
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, page]);

  useEffect(() => {
    loadLocationOptions();
    const channel = supabase
      .channel("parts-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "parts" }, () => {
        loadRef.current();
        loadLocationOptions();
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  // Jei filtras arba trynimas kitur sumažino rezultatų skaičių ir dabartinis
  // puslapis liko už ribų, grąžina į paskutinį galiojantį puslapį.
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

  async function loadWriteoffHistory(partId) {
    setLoadingHistoryId(partId);
    const { data } = await supabase
      .from("parts_writeoffs")
      .select("id, quantity, reason_type, price, rma, reason, created_at, undone_at, profiles!user_id(username)")
      .eq("part_id", partId)
      .order("created_at", { ascending: false });
    setWriteoffHistory((prev) => ({ ...prev, [partId]: data || [] }));
    setLoadingHistoryId(null);
  }

  async function handleUndoWriteoff(writeoff, partId) {
    if (!confirm(`Ar tikrai norite atšaukti šį nurašymą? ${writeoff.quantity} vnt. bus grąžinta į likutį.`)) return;
    setUndoingId(writeoff.id);
    const { error } = await supabase.rpc("undo_writeoff", { p_writeoff_id: writeoff.id });
    setUndoingId(null);
    if (error) {
      setActionError(`Nepavyko atšaukti nurašymo: ${error.message}`);
      return;
    }
    loadWriteoffHistory(partId);
  }

  // Grąžina klaidos tekstą, jei nepavyko — WriteoffModal tada rodo ją
  // formoje ir NEUŽDARO jos.
  async function handleWriteoff(part, { quantity, reasonType, price, rma, reason }) {
    const { error } = await supabase.rpc("writeoff_part", {
      p_part_id: part.id,
      p_quantity: quantity,
      p_reason_type: reasonType,
      p_price: price,
      p_rma: rma,
      p_reason: reason
    });
    if (error) return error.message;
    setWriteoffPart(null);
    loadWriteoffHistory(part.id);
  }

  async function handleSaveQuantity(part) {
    const raw = quantityDrafts[part.id] ?? "";
    const value = Math.max(0, Math.round(Number(raw)) || 0);
    setSavingId(part.id);
    const { error } = await supabase.from("parts").update({ quantity: value }).eq("id", part.id);
    setSavingId(null);
    if (error) setActionError(`Nepavyko išsaugoti kiekio: ${error.message}`);
  }

  // Greitas +/− vieno vieneto paėmimui/pridėjimui — pritaiko prie DABAR
  // rodomos (draft) reikšmės ir iškart išsaugo, be atskiro "Išsaugoti"
  // paspaudimo. Skaičiaus laukas + "Išsaugoti" lieka masinei korekcijai.
  async function handleStep(part, delta) {
    if (savingId === part.id) return;
    const base = Math.round(Number(quantityDrafts[part.id])) || 0;
    const value = Math.max(0, base + delta);
    setSavingId(part.id);
    const { error } = await supabase.from("parts").update({ quantity: value }).eq("id", part.id);
    setSavingId(null);
    if (error) {
      setActionError(`Nepavyko atnaujinti kiekio: ${error.message}`);
      return;
    }
    setQuantityDrafts((prev) => ({ ...prev, [part.id]: String(value) }));
  }

  async function handleSaveNotes(part) {
    setSavingNotesId(part.id);
    const value = notesDrafts[part.id] || "";
    const { error } = await supabase.from("parts").update({ notes: value.trim() || null }).eq("id", part.id);
    setSavingNotesId(null);
    if (error) setActionError(`Nepavyko išsaugoti pastabos: ${error.message}`);
  }

  // Grąžina klaidos tekstą, jei nepavyko — PartFormModal tada rodo ją
  // formoje ir NEUŽDARO jos (kad vartotojas neprarastų įvestų duomenų).
  async function handleSaveEdit(partId, form) {
    const { error } = await supabase
      .from("parts")
      .update({
        main_model: form.main_model.trim() || null,
        name: form.name.trim() || null,
        part_code: form.part_code.trim(),
        location: Math.round(Number(form.location)) || 0,
        min_quantity: form.min_quantity === "" ? null : Math.max(0, Math.round(Number(form.min_quantity)) || 0),
        compatible_models: form.compatible_models.trim() || null,
        online_store: form.online_store
      })
      .eq("id", partId);
    if (error) return error.message;
    setEditingPart(null);
  }

  async function handleCreatePart(form) {
    const { error } = await supabase.from("parts").insert({
      main_model: form.main_model.trim() || null,
      name: form.name.trim() || null,
      part_code: form.part_code.trim(),
      location: Math.round(Number(form.location)) || 0,
      quantity: Math.max(0, Math.round(Number(form.quantity)) || 0),
      min_quantity: form.min_quantity === "" ? null : Math.max(0, Math.round(Number(form.min_quantity)) || 0),
      compatible_models: form.compatible_models.trim() || null,
      online_store: form.online_store
    });
    if (error) return error.message;
    setCreating(false);
  }

  async function handleDelete(part) {
    if (!confirm(`Ar tikrai norite ištrinti „${part.name || part.part_code}“? Šio veiksmo negalima atšaukti.`)) return;
    setDeletingId(part.id);
    const { error } = await supabase.from("parts").delete().eq("id", part.id);
    setDeletingId(null);
    if (error) setActionError(`Nepavyko ištrinti: ${error.message}`);
  }

  async function handleExport() {
    setExporting(true);
    const { data } = await buildQuery();
    await exportPartsToExcel(data || [], `Priedai-${new Date().toISOString().slice(0, 10)}.xlsx`);
    setExporting(false);
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Priedai</h1>
        <p className="mt-1 text-sm text-ink-600/70">
          Priedų (atsarginių dalių) sandėlio paieška ir kiekio redagavimas.
        </p>
      </div>

      {!user && (
        <div className="rounded-xl border border-ink-700/10 bg-ink-900/[0.02] px-3.5 py-2.5 text-sm text-ink-600/70">
          Peržiūros režimas — bet kas gali matyti sąrašą. Norėdami redaguoti kiekius ar duomenis, prisijunkite (viršuje).
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
            placeholder="Ieškoti pagal kodą, pavadinimą, modelį arba suderinamą modelį…"
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
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="btn-primary shrink-0"
          >
            <PackagePlus size={15} /> Pridėti priedą
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-ink-600/70">
          Lokacija
          <select
            value={locationFilter}
            onChange={(e) => setLocationFilter(e.target.value)}
            className="input-field w-auto py-1.5 text-sm"
          >
            <option value="">Visos</option>
            {locationOptions.map((loc) => (
              <option key={loc} value={String(loc)}>{loc}</option>
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
        {(locationFilter !== "" || stockFilter !== "all") && (
          <button
            type="button"
            onClick={() => { setLocationFilter(""); setStockFilter("all"); }}
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
        ) : parts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Boxes className="text-ink-600/30" size={24} />
            <p className="text-sm text-ink-600/60">
              {totalCount === 0 && debouncedSearch.trim() === "" && locationFilter === "" && stockFilter === "all"
                ? "Priedų dar nėra — importuokite juos per /priedai/importas."
                : "Pagal paiešką nieko nerasta."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-ink-900/5 bg-ink-900/[0.02] text-xs uppercase tracking-wide text-ink-600/60">
                <tr>
                  <th className="w-8 px-2 py-2.5"></th>
                  <th className="px-3 py-2.5 font-semibold">Priedas</th>
                  {/* Atskiri stulpeliai tik nuo sm ir aukščiau (desktop/planšetė), kur vietos užtenka;
                      telefone tie patys laukai rodomi kompaktiškai po pavadinimu (žr. žemiau). */}
                  <th className="hidden px-3 py-2.5 font-semibold sm:table-cell">Modelis</th>
                  <th className="hidden px-3 py-2.5 font-semibold sm:table-cell">Kodas</th>
                  <th className="hidden px-3 py-2.5 font-semibold sm:table-cell">El. p-vė</th>
                  <th className="hidden px-3 py-2.5 font-semibold sm:table-cell">Lok.</th>
                  {/* "Kiekis" — sticky, visada matomas be horizontalaus skrolinimo telefone. */}
                  <th className="sticky right-0 z-10 bg-white px-3 py-2.5 font-semibold">Kiekis</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-900/5">
                {parts.map((p) => {
                  const draft = quantityDrafts[p.id] ?? "";
                  const changed = draft !== String(p.quantity ?? 0);
                  const expanded = expandedIds.has(p.id);
                  const notesDraft = notesDrafts[p.id] ?? "";
                  const level = p.stock_level || "ok";
                  const rowTone =
                    level === "out"
                      ? "bg-signal-red/[0.04] hover:bg-signal-red/[0.07]"
                      : level === "low"
                      ? "bg-signal-amber/[0.05] hover:bg-signal-amber/[0.08]"
                      : "hover:bg-ink-900/[0.015]";
                  return (
                    <Fragment key={p.id}>
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
                            onClick={() => toggleExpand(p.id)}
                            className="rounded-lg p-1 text-ink-600/50 hover:bg-ink-900/5 hover:text-ink-900"
                            aria-label="Peržiūrėti daugiau"
                          >
                            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                          </button>
                        </td>
                        <td className="max-w-[220px] px-3 py-2.5">
                          <p className="truncate text-ink-800">{p.name || "—"}</p>
                          {/* Kompaktiška versija tik telefone — nuo sm šie laukai jau turi savo stulpelius. */}
                          <p className="truncate text-xs text-ink-600/60 sm:hidden">
                            {p.main_model || "—"} · <span className="font-mono">{p.part_code}</span>
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 sm:hidden">
                            <span className="text-[10px] font-semibold text-ink-600/50">Lok. {p.location}</span>
                            <span
                              className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                                p.online_store
                                  ? "border-signal-teal/30 bg-signal-teal/10 text-signal-teal"
                                  : "border-ink-700/15 bg-ink-900/[0.03] text-ink-600/60"
                              }`}
                            >
                              {p.online_store ? "Taip" : "Ne"}
                            </span>
                          </div>
                        </td>
                        <td className="hidden max-w-[140px] truncate px-3 py-2.5 text-ink-800 sm:table-cell">{p.main_model || "—"}</td>
                        <td className="hidden max-w-[110px] truncate px-3 py-2.5 font-mono text-ink-900 sm:table-cell">{p.part_code}</td>
                        <td className="hidden px-3 py-2.5 sm:table-cell">
                          <span
                            className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                              p.online_store
                                ? "border-signal-teal/30 bg-signal-teal/10 text-signal-teal"
                                : "border-ink-700/15 bg-ink-900/[0.03] text-ink-600/60"
                            }`}
                          >
                            {p.online_store ? "Taip" : "Ne"}
                          </span>
                        </td>
                        <td className="hidden px-3 py-2.5 font-bold text-ink-900 sm:table-cell">{p.location}</td>
                        <td className="sticky right-0 z-10 bg-white px-3 py-2.5">
                          {canEdit ? (
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleStep(p, -1)}
                                disabled={savingId === p.id || Number(draft) <= 0}
                                className="btn-secondary shrink-0 px-1.5 py-1"
                                aria-label="Sumažinti 1 vnt."
                              >
                                <Minus size={13} />
                              </button>
                              <input
                                type="number"
                                min={0}
                                value={draft}
                                onChange={(e) =>
                                  setQuantityDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                                }
                                className="input-field w-16 shrink-0 py-1 text-center text-xs [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                              />
                              <button
                                type="button"
                                onClick={() => handleStep(p, 1)}
                                disabled={savingId === p.id}
                                className="btn-secondary shrink-0 px-1.5 py-1"
                                aria-label="Padidinti 1 vnt."
                              >
                                <Plus size={13} />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleSaveQuantity(p)}
                                disabled={!changed || savingId === p.id}
                                className="btn-secondary shrink-0 px-1.5 py-1"
                                aria-label="Išsaugoti kiekį"
                              >
                                {savingId === p.id ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                              </button>
                            </div>
                          ) : (
                            <span className="font-semibold text-ink-800">{p.quantity ?? 0}</span>
                          )}
                        </td>
                      </tr>

                      {expanded && (
                        <tr className="bg-ink-900/[0.015]">
                          <td colSpan={7} className="px-4 py-4">
                            <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
                              <div className="flex h-28 w-full flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-ink-700/15 text-ink-600/40 sm:w-40">
                                <ImageIcon size={22} />
                                <span className="text-[11px]">Nuotrauka (netrukus)</span>
                              </div>

                              <div className="space-y-3">
                                <div>
                                  <p className="mb-1 text-xs font-semibold text-ink-600/70">Suderinami modeliai</p>
                                  <p className="text-sm text-ink-800">{p.compatible_models || "—"}</p>
                                </div>

                                <div>
                                  <p className="mb-1 text-xs font-semibold text-ink-600/70">Min. likutis</p>
                                  <p className="text-sm text-ink-800">
                                    {p.min_quantity != null
                                      ? p.min_quantity
                                      : `${DEFAULT_LOW_STOCK_THRESHOLD} (numatyta)`}
                                  </p>
                                </div>

                                <div>
                                  <p className="mb-1 text-xs font-semibold text-ink-600/70">Pastaba</p>
                                  {canEdit ? (
                                    <div className="flex items-start gap-2">
                                      <textarea
                                        value={notesDraft}
                                        onChange={(e) =>
                                          setNotesDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                                        }
                                        rows={2}
                                        placeholder="Pastaba apie priedą (nebūtina)"
                                        className="input-field flex-1 resize-none py-2 text-sm"
                                      />
                                      <button
                                        type="button"
                                        onClick={() => handleSaveNotes(p)}
                                        disabled={
                                          savingNotesId === p.id || notesDraft === (p.notes || "")
                                        }
                                        className="btn-secondary shrink-0 px-2.5 py-2"
                                        aria-label="Išsaugoti pastabą"
                                      >
                                        {savingNotesId === p.id
                                          ? <Loader2 size={14} className="animate-spin" />
                                          : <Save size={14} />}
                                      </button>
                                    </div>
                                  ) : (
                                    <p className="text-sm text-ink-800">{p.notes || "—"}</p>
                                  )}
                                </div>

                                {(canEdit || canDelete) && (
                                  <div className="flex flex-wrap gap-2">
                                    {canEdit && (
                                      <button
                                        type="button"
                                        onClick={() => setEditingPart(p)}
                                        className="btn-secondary"
                                      >
                                        <Pencil size={14} /> Redaguoti
                                      </button>
                                    )}
                                    {canDelete && (
                                      <button
                                        type="button"
                                        onClick={() => setWriteoffPart(p)}
                                        disabled={(p.quantity ?? 0) <= 0}
                                        className="btn-secondary border-signal-amber/30 text-signal-amber hover:bg-signal-amber/10"
                                      >
                                        <PackageMinus size={14} /> Nurašyti
                                      </button>
                                    )}
                                    {canDelete && (
                                      <button
                                        type="button"
                                        onClick={() => handleDelete(p)}
                                        disabled={deletingId === p.id}
                                        className="btn-secondary border-signal-red/30 text-signal-red hover:bg-signal-red/10"
                                      >
                                        {deletingId === p.id
                                          ? <Loader2 size={14} className="animate-spin" />
                                          : <Trash2 size={14} />}
                                        Ištrinti
                                      </button>
                                    )}
                                  </div>
                                )}

                                {canDelete && (
                                  <div>
                                    <p className="mb-1 text-xs font-semibold text-ink-600/70">Nurašymų istorija</p>
                                    {loadingHistoryId === p.id ? (
                                      <Loader2 size={14} className="animate-spin text-ink-600/40" />
                                    ) : (writeoffHistory[p.id] || []).length === 0 ? (
                                      <p className="text-sm text-ink-600/50">Nurašymų nebuvo.</p>
                                    ) : (
                                      <ul className="space-y-1">
                                        {writeoffHistory[p.id].map((w) => (
                                          <li
                                            key={w.id}
                                            className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs ${
                                              w.undone_at ? "text-ink-600/40 line-through" : "text-ink-600/70"
                                            }`}
                                          >
                                            <span>
                                              <span className="font-semibold text-ink-800">-{w.quantity} vnt.</span>
                                              {" · "}
                                              {new Date(w.created_at).toLocaleDateString("lt-LT")}
                                              {" · "}
                                              {WRITEOFF_REASONS.find((r) => r.value === w.reason_type)?.label || w.reason_type}
                                              {w.reason_type === "parduota" && w.price != null && ` (${w.price} €)`}
                                              {w.reason_type === "remontui" && w.rma && ` (RMA: ${w.rma})`}
                                              {w.reason_type === "kita" && w.reason && ` (${w.reason})`}
                                              {w.profiles?.username && ` · ${w.profiles.username}`}
                                              {w.undone_at && " · atšaukta"}
                                            </span>
                                            {!w.undone_at && (
                                              <button
                                                type="button"
                                                onClick={() => handleUndoWriteoff(w, p.id)}
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
              <span className="text-xs font-medium text-ink-600/70">
                {page + 1} / {totalPages}
              </span>
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

      {editingPart && (
        <PartFormModal
          title="Redaguoti priedą"
          initial={editingPart}
          onClose={() => setEditingPart(null)}
          onSave={(form) => handleSaveEdit(editingPart.id, form)}
        />
      )}

      {creating && (
        <PartFormModal
          title="Naujas priedas"
          initial={null}
          showQuantity
          onClose={() => setCreating(false)}
          onSave={handleCreatePart}
        />
      )}

      {writeoffPart && (
        <WriteoffModal
          part={writeoffPart}
          onClose={() => setWriteoffPart(null)}
          onSave={(form) => handleWriteoff(writeoffPart, form)}
        />
      )}
    </div>
  );
}

const WRITEOFF_REASONS = [
  { value: "parduota", label: "Parduota" },
  { value: "remontui", label: "Panaudota remontui" },
  { value: "kita", label: "Kita" }
];

function WriteoffModal({ part, onClose, onSave }) {
  const [quantity, setQuantity] = useState("1");
  const [reasonType, setReasonType] = useState("");
  const [price, setPrice] = useState("");
  const [rma, setRma] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    const value = Math.round(Number(quantity));
    if (!value || value <= 0) {
      setError("Įveskite teigiamą kiekį.");
      return;
    }
    if (value > (part.quantity ?? 0)) {
      setError(`Negalima nurašyti daugiau nei turima likutyje (${part.quantity ?? 0}).`);
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
      quantity: value,
      reasonType,
      price: reasonType === "parduota" ? Number(price) : null,
      rma: reasonType === "remontui" ? rma.trim() : null,
      reason: reasonType === "kita" ? reason.trim() : null
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
          <h2 className="text-base font-bold text-ink-900">Nurašyti priedą</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-ink-900/5">
            <X size={18} />
          </button>
        </div>

        <p className="mb-3 text-sm text-ink-600/70">
          {part.name || part.part_code} — turima likutyje: <span className="font-semibold text-ink-800">{part.quantity ?? 0}</span>
        </p>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Nurašomas kiekis</label>
            <input
              type="number"
              min={1}
              max={part.quantity ?? 0}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="input-field"
              autoFocus
              required
            />
          </div>
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
            Nurašyti
          </button>
        </div>
      </form>
    </div>
  );
}

function PartFormModal({ title, initial, onClose, onSave, showQuantity = false }) {
  const [form, setForm] = useState({
    main_model: initial?.main_model || "",
    name: initial?.name || "",
    part_code: initial?.part_code || "",
    location: initial?.location ?? 0,
    quantity: initial?.quantity ?? 0,
    min_quantity: initial?.min_quantity ?? "",
    compatible_models: initial?.compatible_models || "",
    online_store: !!initial?.online_store
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // onSave grąžina klaidos tekstą, jei nepavyko — tokiu atveju forma
  // NEUŽSIDARO (onClose nekviečiamas), kad vartotojas neprarastų įvesties.
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
      <form
        onSubmit={submit}
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-panel sm:rounded-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-ink-900/5">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pagrindinis modelis</label>
            <input
              value={form.main_model}
              onChange={(e) => setForm({ ...form, main_model: e.target.value })}
              className="input-field"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pavadinimas</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="input-field"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Detalės kodas</label>
            <input
              value={form.part_code}
              onChange={(e) => setForm({ ...form, part_code: e.target.value })}
              className="input-field font-mono"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Lokacija</label>
            <input
              type="number"
              min={0}
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              className="input-field"
              required
            />
          </div>
          {showQuantity && (
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">Kiekis</label>
              <input
                type="number"
                min={0}
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                className="input-field"
                required
              />
            </div>
          )}
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
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Suderinami modeliai</label>
            <textarea
              value={form.compatible_models}
              onChange={(e) => setForm({ ...form, compatible_models: e.target.value })}
              rows={2}
              className="input-field resize-none"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={form.online_store}
              onChange={(e) => setForm({ ...form, online_store: e.target.checked })}
              className="h-4 w-4 rounded border-ink-700/30 text-signal-orange focus:ring-signal-orange/30"
            />
            Parduodama el. parduotuvėje
          </label>
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
