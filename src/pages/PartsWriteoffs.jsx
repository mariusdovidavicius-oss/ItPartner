import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Search, Loader2, ChevronLeft, ChevronRight, PackageMinus, Download, AlertCircle, X } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { escapeLike, formatDate } from "../lib/format";
import { PART_WRITEOFF_REASONS, reasonLabelMap, summarizeWriteoffs, writeoffDetail } from "../lib/writeoffReasons";
import { periodKey, periodRange, periodStateFromParams } from "../lib/period";
import { fetchAllRows } from "../lib/fetchAll";
import WriteoffSummary from "../components/WriteoffSummary";
import PeriodFilter from "../components/PeriodFilter";

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const REASON_LABELS = reasonLabelMap(PART_WRITEOFF_REASONS);
const SEARCH_DEBOUNCE_MS = 300;

// "Detalės" stulpelio turinys priklauso nuo priežasties (parduota — kaina,
// remontui — RMA, kita — laisvas tekstas), todėl antraštė keičiasi pagal
// pasirinktą priežasties filtrą; kai rodomos visos — bendra antraštė.
const DETAIL_HEADERS = { parduota: "Kaina", remontui: "RMA Nr.", kita: "Priežastis" };
const DETAIL_HEADER_ALL = "Kaina / RMA / Priežastis";

export default function PartsWriteoffs() {
  // Pradiniai priežasties ir laikotarpio filtrai gali ateiti iš URL (žr.
  // /statistika nurašymų plytelių nuorodas — pvz. "?priezastis=parduota&
  // laikotarpis=30d") — skaitomi TIK vieną kartą (lazy init), toliau valdomi
  // įprastai per UI.
  const [searchParams] = useSearchParams();
  const [writeoffs, setWriteoffs] = useState([]);
  const [summary, setSummary] = useState(null);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [reasonFilter, setReasonFilter] = useState(() => {
    const v = searchParams.get("priezastis");
    return v && v in REASON_LABELS ? v : "all";
  });
  // Laikotarpis: ?laikotarpis=30d|month|lastmonth|ytd arba ?nuo=YYYY-MM-DD&iki=YYYY-MM-DD (lib/period.js)
  const [periodState, setPeriodState] = useState(() => periodStateFromParams(searchParams));
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [undoingId, setUndoingId] = useState(null);
  const [actionError, setActionError] = useState("");
  const [summaryError, setSummaryError] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // "parts!inner" — priedo pavadinimas/kodas paieškai; saugu naudoti inner
  // join, nes parts SELECT dabar viešas visiems (žr. migrate_parts_public_view.sql),
  // tad joks parts_writeoffs įrašas nebus "prarastas" dėl RLS. "profiles" TYČIA
  // paliktas be "!inner" (paprastas left join) — profiles RLS leidžia matyti
  // tik savo arba (adminui) visų vartotojų username, tad su inner join
  // write-off'ai, kuriuos padarė kiti vartotojai, tiesiog dingtų iš sąrašo
  // ne-adminui. Dėl to paieška apima tik priedo pavadinimą/kodą, ne vartotoją.
  function buildQuery(opts = {}) {
    let query = supabase.from("parts_writeoffs").select(
      opts.select ??
        "id, quantity, reason_type, price, rma, reason, created_at, undone_at, parts!inner(name, part_code, main_model, location), profiles!user_id(username)",
      opts.count ? { count: opts.count } : undefined
    );

    const tokens = debouncedSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
    tokens.forEach((token) => {
      const q = escapeLike(token);
      query = query.or(`name.ilike.%${q}%,part_code.ilike.%${q}%,main_model.ilike.%${q}%`, { referencedTable: "parts" });
    });

    if (reasonFilter !== "all") query = query.eq("reason_type", reasonFilter);

    const { from, to } = periodRange(periodState);
    if (from) query = query.gte("created_at", from);
    if (to) query = query.lt("created_at", to); // "to" — išskirtinė riba (kitos dienos pradžia)

    // Suvestinei skaičiuojami tik aktyvūs (neatšaukti) nurašymai — kaip ir /statistika.
    if (opts.activeOnly) query = query.is("undone_at", null);

    // "id" — antrinis rikiavimo raktas: "created_at" nėra unikalus (kelios
    // eilutės gali gimti tą pačią sekundę), todėl be jo puslapiavimas
    // (fetchAllRows serijoje ar .range() tarp dviejų atskirų užklausų) galėtų
    // nenuosekliai praleisti/dubliuoti eilutę ties puslapio riba.
    return query.order("created_at", { ascending: false }).order("id", { ascending: false });
  }

  // Užklausos numeris — apsaugo nuo pasenusio atsakymo: jei filtrai pasikeičia
  // greičiau, nei spėja grįžti ankstesnis load() (pvz. paspaudus kelis
  // laikotarpio/priežasties filtrus iš eilės), pasenusio atsakymo setState'ai
  // ignoruojami, kad ekranas neliktų rodyti nebeaktualaus filtro rezultatų.
  const requestIdRef = useRef(0);

  async function load() {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setSummaryError("");
    const from = page * pageSize;
    const to = from + pageSize - 1;
    // "parts!inner(id)" — paieškos filtras (name/part_code/main_model) remiasi
    // parts join'u, todėl jis turi būti ir suvestinės užklausoje.
    const [{ data, count }, summaryResult] = await Promise.all([
      buildQuery({ count: "exact" }).range(from, to),
      fetchAllRows(() =>
        buildQuery({ select: "quantity, reason_type, price, parts!inner(id)", activeOnly: true })
      ).then(
        (rows) => ({ rows }),
        (error) => ({ error })
      )
    ]);
    if (requestId !== requestIdRef.current) return; // atėjo pasenęs atsakymas
    setWriteoffs(data || []);
    setTotalCount(count ?? 0);
    setSummary(summaryResult.rows ? summarizeWriteoffs(summaryResult.rows) : null);
    if (summaryResult.error) setSummaryError("Nepavyko įkelti suvestinės sumos.");
    setLoading(false);
  }

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  // Filtro pasikeitimas turi grąžinti į 1 puslapį PRIEŠ pakraunant — abu
  // veiksmai sujungti į vieną efektą (žr. tą patį komentarą Parts.jsx),
  // kad load() nesuveiktų su dar pasenusia "page" reikšme.
  const filterKey = `${debouncedSearch}|${reasonFilter}|${periodKey(periodState)}|${pageSize}`;
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

  useEffect(() => {
    const channel = supabase
      .channel("parts-writeoffs-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "parts_writeoffs" }, () => loadRef.current())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  useEffect(() => {
    if (page > totalPages - 1) setPage(Math.max(0, totalPages - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalCount, pageSize]);

  async function handleUndo(writeoff) {
    if (!confirm(`Ar tikrai norite atšaukti šį nurašymą? ${writeoff.quantity} vnt. bus grąžinta į likutį.`)) return;
    setUndoingId(writeoff.id);
    const { error } = await supabase.rpc("undo_writeoff", { p_writeoff_id: writeoff.id });
    setUndoingId(null);
    if (error) {
      setActionError(`Nepavyko atšaukti nurašymo: ${error.message}`);
      return;
    }
    load();
  }

  async function handleExport() {
    setExporting(true);
    try {
      // Visos filtrą atitinkančios eilutės (ne tik pirmos 1000) — pvz. mėnesio pardavimų ataskaita
      const [data, { exportPartsWriteoffsToExcel }] = await Promise.all([fetchAllRows(() => buildQuery()), import("../lib/exportExcel")]);
      await exportPartsWriteoffsToExcel(data, `Nurasymai-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      setActionError(`Nepavyko eksportuoti: ${e?.message || "nežinoma klaida"}`);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Nurašymai</h1>
        <p className="mt-1 text-sm text-ink-600/70">Visų nurašytų priedų istorija.</p>
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

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative min-w-[220px] flex-1">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-600/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Ieškoti pagal priedo pavadinimą, kodą arba modelį…"
            autoComplete="off"
            className="input-field pl-10"
          />
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-ink-600/70">
          Priežastis
          <select
            value={reasonFilter}
            onChange={(e) => setReasonFilter(e.target.value)}
            className="input-field w-auto py-1.5 text-sm"
          >
            <option value="all">Visos</option>
            {Object.entries(REASON_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <PeriodFilter value={periodState} onChange={setPeriodState} />
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
      </div>

      {!loading && (
        <div className="flex flex-wrap items-center gap-3">
          <WriteoffSummary summary={summary} />
          {summaryError && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-signal-red">
              <AlertCircle size={13} /> {summaryError}
            </span>
          )}
        </div>
      )}

      <div className="panel overflow-hidden p-0">
        {loading ? (
          <div className="flex justify-center py-10 text-ink-600/50">
            <Loader2 className="animate-spin" size={20} />
          </div>
        ) : writeoffs.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <PackageMinus className="text-ink-600/30" size={24} />
            <p className="text-sm text-ink-600/60">
              {totalCount === 0 &&
              debouncedSearch.trim() === "" &&
              reasonFilter === "all" &&
              !periodRange(periodState).from &&
              !periodRange(periodState).to
                ? "Nurašymų dar nėra."
                : "Pagal paiešką nieko nerasta."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-ink-900/5 bg-ink-900/[0.02] text-xs uppercase tracking-wide text-ink-600/60">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">Data</th>
                  <th className="px-3 py-2.5 font-semibold">Priedas</th>
                  <th className="px-3 py-2.5 font-semibold">Modelis</th>
                  <th className="px-3 py-2.5 font-semibold">Kodas</th>
                  <th className="px-3 py-2.5 font-semibold">Kiekis</th>
                  <th className="px-3 py-2.5 font-semibold">Priežastis</th>
                  <th className="px-3 py-2.5 font-semibold">{DETAIL_HEADERS[reasonFilter] || DETAIL_HEADER_ALL}</th>
                  <th className="px-3 py-2.5 font-semibold">Kas</th>
                  <th className="px-3 py-2.5 font-semibold">Būsena</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-900/5">
                {writeoffs.map((w) => (
                  <tr key={w.id} className={`hover:bg-ink-900/[0.015] ${w.undone_at ? "text-ink-600/40 line-through" : ""}`}>
                    <td className="px-3 py-2.5 text-ink-600/70">{formatDate(w.created_at)}</td>
                    <td className="max-w-[180px] truncate px-3 py-2.5 text-ink-800" title={w.parts?.name || undefined}>{w.parts?.name || "—"}</td>
                    <td className="max-w-[160px] truncate px-3 py-2.5 text-ink-600/80" title={w.parts?.main_model || undefined}>{w.parts?.main_model || "—"}</td>
                    <td className="max-w-[110px] truncate px-3 py-2.5 font-mono text-ink-900">{w.parts?.part_code || "—"}</td>
                    <td className="px-3 py-2.5 font-semibold text-ink-800">-{w.quantity}</td>
                    <td className="px-3 py-2.5 text-ink-800">{REASON_LABELS[w.reason_type] || w.reason_type}</td>
                    <td className="max-w-[160px] truncate px-3 py-2.5 text-ink-600/70" title={writeoffDetail(w)}>{writeoffDetail(w)}</td>
                    <td className="px-3 py-2.5 text-ink-600/70">{w.profiles?.username || "—"}</td>
                    <td className="px-3 py-2.5 no-underline">
                      {w.undone_at ? (
                        <span className="text-xs text-ink-600/50">Atšaukta</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleUndo(w)}
                          disabled={undoingId === w.id}
                          className="text-xs font-medium text-signal-orange underline decoration-dotted hover:text-signal-orange/80 disabled:opacity-50"
                        >
                          {undoingId === w.id ? "Atšaukiama…" : "Atšaukti"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
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
    </div>
  );
}
