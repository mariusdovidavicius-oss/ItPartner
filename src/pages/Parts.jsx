import { Fragment, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Search, Loader2, Save, Boxes, Minus, Plus, ChevronLeft, ChevronRight,
  ChevronDown, ChevronUp, ImageIcon, Pencil, X, PackagePlus, PackageMinus, Trash2, Download, AlertCircle,
  ArrowRightLeft, Send, CheckCircle2, Clock
} from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../lib/AuthProvider";
import { stockLevelRowTone, stockLevelBorderClass, stockLevelTitle } from "../lib/stockLevel";
import { searchPattern, formatDate } from "../lib/format";
import { fetchAllRows } from "../lib/fetchAll";
import { PART_WRITEOFF_REASONS as WRITEOFF_REASONS } from "../lib/writeoffReasons";
import { localDateStr } from "../lib/tasks";
import { sendPush } from "../lib/push";

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const HISTORY_PAGE_SIZE = 5; // po kiek nurašymų istorijos įrašų rodoma iš karto (žr. "Rodyti daugiau")
// Numatytasis mažo likučio slenkstis, kai priedas neturi savo individualaus
// "min_quantity" — turi atitikti DB pusės part_totals VIEW stock_level
// fallback reikšmę (žr. migrate_parts_split_stock.sql).
const DEFAULT_LOW_STOCK_THRESHOLD = 3;
const SEARCH_DEBOUNCE_MS = 300;
const STOCK_SELECT = "id, part_id, warehouse_id, location, quantity, warehouses(name)";

// Priedai sutvarkyti kaip prietaisai: parts — katalogas (vienas įrašas
// vienam priedui), part_stock — kiekis kiekvienoje vietoje (sandėlis +
// lokacija). Sąrašas skaito part_totals VIEW (bendras kiekis, stock_level),
// o vietos pakraunamos atskira užklausa tik matomo puslapio priedams.

// Pagrindinis modelis visada suderinamas su savimi, todėl visada rodomas
// suderinamų modelių sąraše (be dublikatų), net kai "compatible_models"
// jau turi kitų modelių.
function formatCompatibleModels(part) {
  const others = (part.compatible_models || "").split(",").map((m) => m.trim()).filter(Boolean);
  const all = [part.main_model, ...others].filter(Boolean);
  return [...new Set(all)].join(", ");
}

// "8" prieš "42", ne raidžių tvarka.
function compareLocations(a, b) {
  return String(a.location || "").localeCompare(String(b.location || ""), undefined, { numeric: true });
}

function placeLabel(s) {
  return `${s.warehouses?.name ? `${s.warehouses.name} — ` : ""}Lokacija ${s.location}`;
}

function totalQuantity(part) {
  return (part.part_stock || []).reduce((sum, s) => sum + (s.quantity || 0), 0);
}

// Ta pati logika, kaip part_totals VIEW stock_level — skaičiuojama ir
// front-end pusėje, kad eilutės spalva atsinaujintų iškart po kiekio
// pakeitimo (kartu su part_stock), nelaukiant VIEW perkrovimo.
function stockLevel(part) {
  const total = totalQuantity(part);
  if (total <= 0) return "out";
  if (total <= (part.min_quantity ?? DEFAULT_LOW_STOCK_THRESHOLD)) return "low";
  return "ok";
}

// 23505 (unikalumo pažeidimas) → suprantamas tekstas. parts_ident_unique —
// toks priedas jau yra kataloge; part_stock_* — šis priedas jau turi tą vietą.
function uniqueErrorMessage(error, { code, location } = {}) {
  if (error.code !== "23505") return error.message;
  if (String(error.message).includes("parts_ident_unique")) {
    return `Priedas „${code || ""}“ jau yra sąraše — suraskite jį paieškoje ir pridėkite vietą per „Redaguoti“.`;
  }
  return `Šis priedas jau turi vietą „${location || ""}“ tame sandėlyje — naudokite „Perkelti“ arba pakeiskite esamos vietos kiekį.`;
}

export default function Parts() {
  const { user, hasPermission } = useAuth();
  const canEdit = hasPermission("edit");
  const canDelete = hasPermission("delete");
  // Pradinė paieška/likučio filtras gali ateiti iš URL (žr. /statistika
  // plytelių nuorodas — pvz. "?likutis=low", "?q=<pavadinimas>") — skaitoma
  // TIK vieną kartą (lazy init), toliau valdoma įprastai per UI.
  const [searchParams] = useSearchParams();
  const [parts, setParts] = useState([]); // dabartinio puslapio priedai (su part_stock)
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(() => searchParams.get("q") || "");
  const [debouncedSearch, setDebouncedSearch] = useState(() => searchParams.get("q") || "");
  const [quantityDrafts, setQuantityDrafts] = useState({}); // part_stock id -> juodraštis
  const [savingStockId, setSavingStockId] = useState(null);
  const [totalDrafts, setTotalDrafts] = useState({}); // part id -> bendro kiekio juodraštis (kai kelios vietos)
  const [savingTotalId, setSavingTotalId] = useState(null);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [editingPart, setEditingPart] = useState(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [writeoffPart, setWriteoffPart] = useState(null);
  const [transferPart, setTransferPart] = useState(null);
  const [shipPart, setShipPart] = useState(null);
  const [shipTasks, setShipTasks] = useState({}); // part id -> šio vartotojo išsiuntimo darbai
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
  const [onlineStoreFilter, setOnlineStoreFilter] = useState("all"); // all | yes | no
  const [warehouseFilter, setWarehouseFilter] = useState(""); // warehouses.id arba "" = visi
  const [warehouseOptions, setWarehouseOptions] = useState([]);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // Bendra užklausa puslapiui ir Excel eksportui (be .range()).
  function buildQuery(opts = {}) {
    let query = supabase.from("part_totals").select(
      "id, part_code, name, main_model, compatible_models, online_store, price, min_quantity, notes, total_quantity, location_count, stock_level, sort_location",
      opts.count ? { count: opts.count } : undefined
    );

    const tokens = debouncedSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
    tokens.forEach((token) => {
      query = query.ilike("search_text", searchPattern(token));
    });

    // Lokacijos filtras rodo tik "dėžės" numerį (pvz. "8"), bet po ta dėže
    // gali būti mažos dėžutės ("8 (-1-)", "8(-2-)") — atitinka tikslią dėžę
    // arba "dėžė + tarpas/skliaustas + …" (NE prefiksą, kad "8" neatitiktų "80").
    // locations_text = "|8 (-1-)|42|" — visos priedo vietos. Reikšmė su "("
    // PostgREST or() filtre turi būti kabutėse.
    if (locationFilter !== "") {
      const esc = locationFilter.replace(/[%,()|*"]/g, "");
      query = query.or(
        `locations_text.ilike.%|${esc}|%,locations_text.ilike.%|${esc} %,locations_text.ilike."%|${esc}(%"`
      );
    }
    if (stockFilter === "out") query = query.eq("stock_level", "out");
    if (stockFilter === "low") query = query.eq("stock_level", "low");
    if (onlineStoreFilter === "yes") query = query.eq("online_store", true);
    if (onlineStoreFilter === "no") query = query.eq("online_store", false);
    if (warehouseFilter) query = query.contains("warehouse_ids", [warehouseFilter]);

    return query
      .order("sort_location", { ascending: true, nullsFirst: false })
      .order("name", { ascending: true })
      .order("id", { ascending: true });
  }

  // Keli load() gali persidengti (realtime + filtro keitimas) — pritaikomas
  // TIK naujausio atsakymas, kad senesnis nepakeistų naujesnio.
  const loadSeq = useRef(0);

  async function load() {
    const seq = ++loadSeq.current;
    setLoading(true);
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, count } = await buildQuery({ count: "exact" }).range(from, to);
    const list = data || [];
    const ids = list.map((p) => p.id);
    const { data: stockRows } = ids.length
      ? await supabase.from("part_stock").select(STOCK_SELECT).in("part_id", ids)
      : { data: [] };
    if (seq !== loadSeq.current) return;

    const byPart = {};
    (stockRows || []).forEach((s) => {
      (byPart[s.part_id] ||= []).push(s);
    });
    const merged = list.map((p) => ({ ...p, part_stock: (byPart[p.id] || []).sort(compareLocations) }));
    setParts(merged);
    setTotalCount(count ?? 0);

    // Juodraštis paliekamas TIK jei vartotojas jį pakeitė (skiriasi nuo
    // ankstesnės DB reikšmės) — kitaip rodomas naujas kiekis (pvz. po
    // perkėlimo ar kito vartotojo pakeitimo).
    const prevQuantities = new Map(
      parts.flatMap((p) => p.part_stock || []).map((s) => [s.id, String(s.quantity ?? 0)])
    );
    setQuantityDrafts((prev) => {
      const next = {};
      merged.forEach((p) => {
        p.part_stock.forEach((s) => {
          const edited = s.id in prev && prev[s.id] !== prevQuantities.get(s.id);
          next[s.id] = edited ? prev[s.id] : String(s.quantity ?? 0);
        });
      });
      return next;
    });

    setLoading(false);
  }

  async function loadLocationOptions() {
    const rows = await fetchAllRows(() => supabase.from("part_stock").select("location").order("id")).catch(() => []);
    // Filtras grupuoja pagal dėžės numerį — "8 (-1-)" ir "8(-2-)" į vieną
    // pasirinkimą "8" (viskas iki tarpo arba "("). Raidžių dydis nesvarbus.
    const map = new Map();
    rows.forEach((r) => {
      const box = (String(r.location || "").trim().match(/^[^\s(]+/) || [""])[0];
      if (box && !map.has(box.toLowerCase())) map.set(box.toLowerCase(), box);
    });
    setLocationOptions([...map.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
  }

  async function loadWarehouseOptions() {
    const { data } = await supabase.from("warehouses").select("id, name").order("name");
    setWarehouseOptions(data || []);
  }

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  // Filtro pasikeitimas turi grąžinti į 1 puslapį PRIEŠ pakraunant (žr.
  // tą pačią logiką Devices.jsx) — abu veiksmai viename efekte.
  const filterKey = `${debouncedSearch}|${locationFilter}|${stockFilter}|${onlineStoreFilter}|${warehouseFilter}|${pageSize}`;
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
    loadLocationOptions();
    loadWarehouseOptions();
    const channel = supabase
      .channel("parts-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "parts" }, () => {
        loadRef.current();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "part_stock" }, () => {
        loadRef.current();
        loadLocationOptions();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "warehouses" }, () => {
        loadWarehouseOptions();
        loadRef.current(); // pervadintas sandėlis — atnaujinti rodomus pavadinimus
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "parts_writeoffs" }, (payload) => {
        const partId = payload.new?.part_id ?? payload.old?.part_id;
        if (partId && expandedIdsRef.current.has(partId)) loadWriteoffHistory(partId);
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
    const expanding = !expandedIds.has(id);
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (canDelete && !(id in writeoffHistory)) loadWriteoffHistory(id);
    // Kiekvieną kartą išskleidus — būsena ("Laukia"/"Paruošta") galėjo pasikeisti.
    if (user && expanding) loadShipTasks(id);
  }

  // Išsiuntimo darbai šiam priedui — RLS grąžina tik paties sukurtus arba
  // jam priskirtus, todėl vadybininkė mato savo pažymėtų būseną.
  async function loadShipTasks(partId) {
    const { data } = await supabase
      .from("tasks")
      .select("id, quantity, order_ref, done, done_at, created_at")
      .eq("part_id", partId)
      .order("created_at", { ascending: false })
      .limit(5);
    setShipTasks((prev) => ({ ...prev, [partId]: data || [] }));
  }

  // Grąžina klaidos tekstą, jei nepavyko (ShipTaskModal jį rodo formoje).
  async function handleCreateShipTask(part, { quantity, orderRef, unitPrice, note, assigneeId }) {
    const { data: created, error } = await supabase.from("tasks").insert({
      title: `Paruošti išsiuntimui: ${part.name || part.part_code}`,
      note: note || null,
      due_date: localDateStr(),
      starred: true, // užsakymas laukia — visada ⭐ (sąrašo viršuje)
      part_id: part.id,
      quantity,
      order_ref: orderRef || null,
      unit_price: unitPrice,
      assigned_to: assigneeId,
      created_by: user.id
    }).select("id").single();
    if (error) return error.message;
    sendPush({ taskId: created.id }).catch(() => {}); // pranešimas sandėlininkui — nepavykus darbas vis tiek sukurtas
    setShipPart(null);
    loadShipTasks(part.id);
  }

  async function loadWriteoffHistory(partId) {
    setLoadingHistoryId(partId);
    const { data } = await supabase
      .from("parts_writeoffs")
      .select("id, location, quantity, reason_type, price, rma, reason, created_at, undone_at, warehouses(name), profiles!user_id(username)")
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
  // formoje ir NEUŽDARO jos. "stockId" — iš kurios vietos nurašoma.
  async function handleWriteoff(part, { stockId, quantity, reasonType, price, rma, reason }) {
    const { error } = await supabase.rpc("writeoff_part", {
      p_stock_id: stockId,
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

  // Perkėlimas tarp vietų (transfer_part_stock RPC) — bendras kiekis
  // nesikeičia. Grąžina klaidos tekstą, jei nepavyko.
  async function handleTransfer({ fromStockId, toWarehouseId, toLocation, quantity }) {
    const { error } = await supabase.rpc("transfer_part_stock", {
      p_from_stock_id: fromStockId,
      p_to_warehouse_id: toWarehouseId,
      p_to_location: toLocation,
      p_quantity: quantity
    });
    if (error) return error.message;
    setTransferPart(null);
  }

  async function saveStockQuantity(stock, value) {
    setSavingStockId(stock.id);
    const { error } = await supabase.from("part_stock").update({ quantity: value }).eq("id", stock.id);
    setSavingStockId(null);
    if (error) {
      setActionError(`Nepavyko išsaugoti kiekio: ${error.message}`);
      return false;
    }
    setQuantityDrafts((prev) => ({ ...prev, [stock.id]: String(value) }));
    return true;
  }

  function handleSaveQuantity(stock) {
    const value = Math.max(0, Math.round(Number(quantityDrafts[stock.id] ?? "")) || 0);
    return saveStockQuantity(stock, value);
  }

  // Greitas +/− vieno vieneto paėmimui/pridėjimui — pritaiko prie DABAR
  // rodomos (draft) reikšmės ir iškart išsaugo.
  function handleStep(stock, delta) {
    if (savingStockId === stock.id) return;
    const base = Math.round(Number(quantityDrafts[stock.id])) || 0;
    return saveStockQuantity(stock, Math.max(0, base + delta));
  }

  // Bendras kiekis (kai priedas keliose vietose) — atskaitos taškas yra
  // kiekvienos vietos dabartinė (draft) reikšmė, kaip ir handleStep.
  function draftQuantity(stock) {
    return Math.max(0, Math.round(Number(quantityDrafts[stock.id] ?? stock.quantity)) || 0);
  }

  function draftTotal(part) {
    return (part.part_stock || []).reduce((sum, s) => sum + draftQuantity(s), 0);
  }

  // Bendro kiekio pakeitimas paskirstomas po vietas: pridedama prie pirmos
  // vietos, atimama iš vietų sąrašo tvarka, kol jose yra likutis.
  async function changeTotal(part, delta) {
    const stock = part.part_stock || [];
    if (!delta || !stock.length || savingTotalId === part.id) return;
    setSavingTotalId(part.id);
    let ok = true;
    if (delta > 0) {
      ok = await saveStockQuantity(stock[0], draftQuantity(stock[0]) + delta);
    } else {
      let remaining = -delta;
      for (const s of stock) {
        if (remaining <= 0) break;
        const current = draftQuantity(s);
        if (current <= 0) continue;
        const take = Math.min(current, remaining);
        ok = await saveStockQuantity(s, current - take);
        if (!ok) break;
        remaining -= take;
      }
    }
    setSavingTotalId(null);
    if (ok) {
      setTotalDrafts((prev) => {
        const next = { ...prev };
        delete next[part.id];
        return next;
      });
    }
  }

  function handleSaveTotal(part) {
    const value = Math.max(0, Math.round(Number(totalDrafts[part.id] ?? "")) || 0);
    return changeTotal(part, value - draftTotal(part));
  }

  async function handleSavePartField(part, patch, label) {
    const { error } = await supabase.from("parts").update(patch).eq("id", part.id);
    if (error) {
      setActionError(`Nepavyko išsaugoti ${label}: ${error.message}`);
      return false;
    }
    return true;
  }

  // Grąžina klaidos tekstą, jei nepavyko — PartFormModal tada rodo ją
  // formoje ir NEUŽDARO jos (kad vartotojas neprarastų įvestų duomenų).
  async function handleSaveEdit(part, form) {
    const { error } = await supabase
      .from("parts")
      .update({
        main_model: form.main_model.trim() || null,
        name: form.name.trim() || null,
        part_code: form.part_code.trim(),
        min_quantity: form.min_quantity === "" ? null : Math.max(0, Math.round(Number(form.min_quantity)) || 0),
        compatible_models: form.compatible_models.trim() || null,
        online_store: form.online_store
      })
      .eq("id", part.id);
    if (error) return uniqueErrorMessage(error, { code: form.part_code.trim() });

    // Vietos: pašalintos (tik su 0 vnt.), pakeistas sandėlis/lokacija, naujos.
    for (const row of form.stock) {
      const location = row.location.trim();
      if (row.removed) {
        const { error: delError } = await supabase.from("part_stock").delete().eq("id", row.id);
        if (delError) return `Nepavyko pašalinti vietos: ${delError.message}`;
        continue;
      }
      if (!location) return "Lokacija negali būti tuščia.";
      if (row.warehouseId === row.origWarehouseId && location === row.origLocation) continue;
      const { error: stockError } = await supabase
        .from("part_stock")
        .update({ warehouse_id: row.warehouseId, location })
        .eq("id", row.id);
      if (stockError) return uniqueErrorMessage(stockError, { location });
    }
    for (const row of form.newStock) {
      const location = row.location.trim();
      if (!row.warehouseId || !location) return "Naujai vietai nurodykite sandėlį ir lokaciją.";
      const { error: insError } = await supabase.from("part_stock").insert({
        part_id: part.id,
        warehouse_id: row.warehouseId,
        location,
        quantity: Math.max(0, Math.round(Number(row.quantity)) || 0)
      });
      if (insError) return uniqueErrorMessage(insError, { location });
    }

    setEditingPart(null);
  }

  async function handleCreatePart(form) {
    const code = form.part_code.trim() || "N/A";
    const location = form.location.trim();
    if (!form.warehouseId || !location) return "Nurodykite sandėlį ir lokaciją.";
    const { data: part, error } = await supabase
      .from("parts")
      .insert({
        main_model: form.main_model.trim() || null,
        name: form.name.trim() || null,
        part_code: code,
        min_quantity: form.min_quantity === "" ? null : Math.max(0, Math.round(Number(form.min_quantity)) || 0),
        compatible_models: form.compatible_models.trim() || null,
        online_store: form.online_store
      })
      .select("id")
      .single();
    if (error) return uniqueErrorMessage(error, { code });

    const { error: stockError } = await supabase.from("part_stock").insert({
      part_id: part.id,
      warehouse_id: form.warehouseId,
      location,
      quantity: Math.max(0, Math.round(Number(form.quantity)) || 0)
    });
    // Priedas JAU sukurtas — modalas uždaromas, kad pakartotinis
    // "Išsaugoti" nebandytų kurti jo antrą kartą; klaida — puslapio lygiu.
    setCreating(false);
    if (stockError) setActionError(`Priedas sukurtas, bet nepavyko įrašyti vietos: ${stockError.message}`);
  }

  async function handleDelete(part) {
    if (!confirm(`Ar tikrai norite ištrinti „${part.name || part.part_code}“ su visomis jo vietomis? Šio veiksmo negalima atšaukti.`)) return;
    setDeletingId(part.id);
    const { error } = await supabase.from("parts").delete().eq("id", part.id);
    setDeletingId(null);
    if (error) setActionError(`Nepavyko ištrinti: ${error.message}`);
  }

  // Eksportas — kiekviena vieta atskira eilute (tas pats formatas, kaip
  // importo failas). Priedas be vietų — viena eilutė su 0.
  async function handleExport() {
    setExporting(true);
    try {
      const [list, stockRows, { exportPartsToExcel }] = await Promise.all([
        fetchAllRows(() => buildQuery()),
        fetchAllRows(() => supabase.from("part_stock").select(STOCK_SELECT).order("id")),
        import("../lib/exportExcel")
      ]);
      const byPart = {};
      stockRows.forEach((s) => {
        (byPart[s.part_id] ||= []).push(s);
      });
      const rows = list.flatMap((p) => {
        const stock = byPart[p.id] || [];
        return stock.length
          ? stock.map((s) => ({ ...p, warehouses: s.warehouses, location: s.location, quantity: s.quantity }))
          : [{ ...p, warehouses: null, location: "", quantity: 0 }];
      });
      await exportPartsToExcel(rows, `Priedai-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (err) {
      setActionError(`Nepavyko eksportuoti: ${err.message}`);
    }
    setExporting(false);
  }

  const quantityEditorProps = (stock) => ({
    stock,
    draft: quantityDrafts[stock.id] ?? "",
    saving: savingStockId === stock.id,
    onDraft: (value) => setQuantityDrafts((prev) => ({ ...prev, [stock.id]: value })),
    onStep: (delta) => handleStep(stock, delta),
    onSave: () => handleSaveQuantity(stock)
  });

  // Tas pats QuantityEditor, bet bendram kiekiui per visas vietas.
  const totalEditorProps = (part) => {
    const total = draftTotal(part);
    return {
      stock: { quantity: total },
      draft: totalDrafts[part.id] ?? String(total),
      saving: savingTotalId === part.id,
      onDraft: (value) => setTotalDrafts((prev) => ({ ...prev, [part.id]: value })),
      onStep: (delta) => changeTotal(part, delta),
      onSave: () => handleSaveTotal(part)
    };
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Priedai</h1>
        <p className="mt-1 text-sm text-ink-600/70">
          Priedų (atsarginių dalių) sandėlio paieška ir kiekių pagal lokaciją redagavimas.
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
          Sandėlis
          <select
            value={warehouseFilter}
            onChange={(e) => setWarehouseFilter(e.target.value)}
            className="input-field w-auto py-1.5 text-sm"
          >
            <option value="">Visi</option>
            {warehouseOptions.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </label>
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
        <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-ink-600/70">
          El. p-vė
          <select
            value={onlineStoreFilter}
            onChange={(e) => setOnlineStoreFilter(e.target.value)}
            className="input-field w-auto py-1.5 text-sm"
          >
            <option value="all">Visi</option>
            <option value="yes">Taip</option>
            <option value="no">Ne</option>
          </select>
        </label>
        {(locationFilter !== "" || stockFilter !== "all" || onlineStoreFilter !== "all" || warehouseFilter !== "") && (
          <button
            type="button"
            onClick={() => { setLocationFilter(""); setStockFilter("all"); setOnlineStoreFilter("all"); setWarehouseFilter(""); }}
            className="text-xs font-medium text-ink-600/60 underline decoration-dotted hover:text-ink-900"
          >
            Išvalyti filtrus
          </button>
        )}
      </div>

      <div className="panel overflow-hidden p-0">
        {loading && parts.length === 0 ? (
          <div className="flex justify-center py-10 text-ink-600/50">
            <Loader2 className="animate-spin" size={20} />
          </div>
        ) : parts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Boxes className="text-ink-600/30" size={24} />
            <p className="text-sm text-ink-600/60">
              {totalCount === 0 && debouncedSearch.trim() === "" && locationFilter === "" && stockFilter === "all" && onlineStoreFilter === "all" && warehouseFilter === ""
                ? "Priedų dar nėra — importuokite juos per /importas."
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
                  const expanded = expandedIds.has(p.id);
                  const stock = p.part_stock || [];
                  const level = stockLevel(p);
                  const rowTone = stockLevelRowTone(level);
                  const locationsTitle = stock.map(placeLabel).join("\n");
                  // Rodoma viena vieta — ta, kurioje daugiausia vienetų (lygiomis —
                  // pirmoji sąraše); visos vietos matomos užvedus pelę ir išskleidus.
                  const mainStock = stock.reduce((best, s) => ((s.quantity ?? 0) > (best.quantity ?? 0) ? s : best), stock[0]);
                  const locationSummary = mainStock ? mainStock.location : "—";
                  return (
                    <Fragment key={p.id}>
                      <tr className={expanded ? "bg-ink-900/[0.015]" : rowTone}>
                        <td
                          className={`w-8 border-l-[3px] px-2 py-2.5 ${stockLevelBorderClass(level)}`}
                          title={stockLevelTitle(level)}
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
                            <span className="text-[10px] font-semibold text-ink-600/50" title={locationsTitle}>Lok. {locationSummary}</span>
                            <OnlineBadge value={p.online_store} />
                          </div>
                        </td>
                        <td className="hidden max-w-[140px] truncate px-3 py-2.5 text-ink-800 sm:table-cell">{p.main_model || "—"}</td>
                        <td className="hidden max-w-[110px] truncate px-3 py-2.5 font-mono text-ink-900 sm:table-cell">{p.part_code}</td>
                        <td className="hidden px-3 py-2.5 sm:table-cell">
                          <OnlineBadge value={p.online_store} />
                        </td>
                        <td className="hidden max-w-[120px] truncate px-3 py-2.5 font-bold text-ink-900 sm:table-cell" title={locationsTitle}>
                          {locationSummary}
                        </td>
                        <td className="sticky right-0 z-10 bg-white px-3 py-2.5">
                          {/* Viena vieta — tos vietos kiekis; kelios — bendras kiekis
                              (žr. changeTotal), o kiekvienos vietos — išskleidus. */}
                          {canEdit && stock.length === 1 ? (
                            <QuantityEditor {...quantityEditorProps(stock[0])} />
                          ) : canEdit && stock.length > 1 ? (
                            <QuantityEditor {...totalEditorProps(p)} />
                          ) : (
                            <span className="whitespace-nowrap font-semibold text-ink-800">
                              {totalQuantity(p)}
                              {stock.length > 1 && (
                                <span className="ml-1 text-[11px] font-normal text-ink-600/50">({stock.length} vietos)</span>
                              )}
                            </span>
                          )}
                        </td>
                      </tr>

                      {expanded && (
                        <tr className="bg-ink-900/[0.015]">
                          <td colSpan={7} className="px-4 py-4">
                            <PartDetail
                              part={p}
                              canEdit={canEdit}
                              canDelete={canDelete}
                              deletingId={deletingId}
                              quantityEditorProps={quantityEditorProps}
                              onSaveField={(patch, label) => handleSavePartField(p, patch, label)}
                              onEdit={() => setEditingPart(p)}
                              onTransfer={() => setTransferPart(p)}
                              canShip={!!user}
                              shipTasks={shipTasks[p.id] || []}
                              onShip={() => setShipPart(p)}
                              onWriteoff={() => setWriteoffPart(p)}
                              onDelete={() => handleDelete(p)}
                              writeoffHistory={writeoffHistory[p.id] || []}
                              loadingHistory={loadingHistoryId === p.id}
                              undoingId={undoingId}
                              onUndoWriteoff={(w) => handleUndoWriteoff(w, p.id)}
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

      {totalCount > 0 && (
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
          onSave={(form) => handleSaveEdit(editingPart, form)}
        />
      )}

      {creating && (
        <PartFormModal
          title="Naujas priedas"
          initial={null}
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

      {transferPart && (
        <PartTransferModal
          part={transferPart}
          onClose={() => setTransferPart(null)}
          onSave={handleTransfer}
        />
      )}

      {shipPart && (
        <ShipTaskModal
          part={shipPart}
          onClose={() => setShipPart(null)}
          onSave={(form) => handleCreateShipTask(shipPart, form)}
        />
      )}
    </div>
  );
}

function OnlineBadge({ value }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        value
          ? "border-signal-teal/30 bg-signal-teal/10 text-signal-teal"
          : "border-ink-700/15 bg-ink-900/[0.03] text-ink-600/60"
      }`}
    >
      {value ? "Taip" : "Ne"}
    </span>
  );
}

// −/laukas/+/išsaugoti — vienos vietos (part_stock eilutės) kiekiui.
function QuantityEditor({ stock, draft, saving, onDraft, onStep, onSave }) {
  const changed = draft !== String(stock.quantity ?? 0);
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onStep(-1)}
        disabled={saving || Number(draft) <= 0}
        className="btn-secondary shrink-0 px-1.5 py-1"
        aria-label="Sumažinti 1 vnt."
      >
        <Minus size={13} />
      </button>
      <input
        type="number"
        min={0}
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        className="input-field w-16 shrink-0 py-1 text-center text-xs [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        onClick={() => onStep(1)}
        disabled={saving}
        className="btn-secondary shrink-0 px-1.5 py-1"
        aria-label="Padidinti 1 vnt."
      >
        <Plus size={13} />
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={!changed || saving}
        className="btn-secondary shrink-0 px-1.5 py-1"
        aria-label="Išsaugoti kiekį"
      >
        {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
      </button>
    </div>
  );
}

function PartDetail({
  part, canEdit, canDelete, deletingId, quantityEditorProps, onSaveField, onEdit, onTransfer, onWriteoff, onDelete,
  canShip, shipTasks, onShip, writeoffHistory, loadingHistory, undoingId, onUndoWriteoff
}) {
  const stock = part.part_stock || [];
  const total = totalQuantity(part);
  const [notesDraft, setNotesDraft] = useState(part.notes || "");
  const [savingNotes, setSavingNotes] = useState(false);
  const [priceDraft, setPriceDraft] = useState(part.price != null ? String(part.price) : "");
  const [savingPrice, setSavingPrice] = useState(false);
  const [priceError, setPriceError] = useState("");
  // Nurašymų istorija: iš pradžių rodoma tik HISTORY_PAGE_SIZE naujausių.
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE_SIZE);

  async function saveNotes() {
    setSavingNotes(true);
    await onSaveField({ notes: notesDraft.trim() || null }, "pastabos");
    setSavingNotes(false);
  }

  // Kaina — nebūtina, orientacinė priedo savybė (atskira nuo nurašymo metu
  // įvedamos parts_writeoffs.price). Tuščias laukas = kaina nenurodyta (null).
  async function savePrice() {
    const raw = priceDraft.trim().replace(",", ".");
    if (raw !== "" && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) {
      setPriceError("Kaina turi būti teigiamas skaičius.");
      return;
    }
    setPriceError("");
    setSavingPrice(true);
    await onSaveField({ price: raw === "" ? null : Number(raw) }, "kainos");
    setSavingPrice(false);
  }

  return (
    <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
      <div className="flex h-28 w-full flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-ink-700/15 text-ink-600/40 sm:w-40">
        <ImageIcon size={22} />
        <span className="text-[11px]">Nuotrauka (netrukus)</span>
      </div>

      <div className="space-y-3">
        <div>
          <p className="mb-1 text-xs font-semibold text-ink-600/70">Pavadinimas</p>
          <p className="text-sm text-ink-800">{part.name || "—"}</p>
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold text-ink-600/70">
            Vietos{stock.length > 1 && ` — iš viso ${total} vnt.`}
          </p>
          {stock.length === 0 ? (
            <p className="text-sm text-ink-600/50">Priedas neturi nė vienos vietos — pridėkite per „Redaguoti“.</p>
          ) : (
            <ul className="space-y-1.5">
              {stock.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-ink-800">
                    {s.warehouses?.name && <span className="font-semibold">{s.warehouses.name}</span>}
                    {s.warehouses?.name && " — "}
                    Lokacija {s.location}
                  </span>
                  {canEdit ? (
                    <QuantityEditor {...quantityEditorProps(s)} />
                  ) : (
                    <span className="text-sm font-semibold text-ink-800">{s.quantity ?? 0} vnt.</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold text-ink-600/70">Suderinami modeliai</p>
          {/* Pagrindinis modelis visada suderinamas su savimi, todėl visada įtraukiamas į sąrašą. */}
          <p className="text-sm text-ink-800">{formatCompatibleModels(part) || "—"}</p>
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold text-ink-600/70">Min. likutis (visam kiekiui)</p>
          <p className="text-sm text-ink-800">
            {part.min_quantity != null ? part.min_quantity : `${DEFAULT_LOW_STOCK_THRESHOLD} (numatyta)`}
          </p>
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold text-ink-600/70">Kaina</p>
          {canEdit ? (
            <>
              <div className="flex items-start gap-2">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={priceDraft}
                  onChange={(e) => setPriceDraft(e.target.value)}
                  placeholder="Nenurodyta"
                  className="input-field w-32 py-2 text-sm"
                />
                <span className="self-center text-sm text-ink-600/50">€</span>
                <button
                  type="button"
                  onClick={savePrice}
                  disabled={savingPrice || priceDraft === (part.price != null ? String(part.price) : "")}
                  className="btn-secondary shrink-0 px-2.5 py-2"
                  aria-label="Išsaugoti kainą"
                >
                  {savingPrice ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                </button>
              </div>
              {priceError && <p className="mt-1 text-xs font-medium text-signal-red">{priceError}</p>}
            </>
          ) : (
            <p className="text-sm text-ink-800">{part.price != null ? `${part.price} €` : "—"}</p>
          )}
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold text-ink-600/70">Pastaba</p>
          {canEdit ? (
            <div className="flex items-start gap-2">
              <textarea
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                rows={2}
                placeholder="Pastaba apie priedą (nebūtina)"
                className="input-field flex-1 resize-none py-2 text-sm"
              />
              <button
                type="button"
                onClick={saveNotes}
                disabled={savingNotes || notesDraft === (part.notes || "")}
                className="btn-secondary shrink-0 px-2.5 py-2"
                aria-label="Išsaugoti pastabą"
              >
                {savingNotes ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              </button>
            </div>
          ) : (
            <p className="whitespace-pre-line text-sm text-ink-800">{part.notes || "—"}</p>
          )}
        </div>

        {canShip && (
          <div>
            <button type="button" onClick={onShip} className="btn-secondary border-signal-blue/30 text-signal-blue hover:bg-signal-blue/10">
              <Send size={14} /> Paruošti išsiuntimui
            </button>
            {shipTasks.length > 0 && (
              <ul className="mt-2 space-y-1">
                {shipTasks.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-1.5 text-xs text-ink-600/80">
                    {t.done ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-signal-teal/10 px-2 py-0.5 font-semibold text-signal-teal">
                        <CheckCircle2 size={12} /> Paruošta {formatDate(t.done_at)}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-signal-orange/10 px-2 py-0.5 font-semibold text-signal-orange">
                        <Clock size={12} /> Laukia
                      </span>
                    )}
                    <span>
                      {t.quantity ?? 1} vnt.{t.order_ref && ` · užs. ${t.order_ref}`} · pažymėta {formatDate(t.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {(canEdit || canDelete) && (
          <div className="flex flex-wrap gap-2">
            {canEdit && (
              <button type="button" onClick={onEdit} className="btn-secondary">
                <Pencil size={14} /> Redaguoti
              </button>
            )}
            {canEdit && (
              <button type="button" onClick={onTransfer} disabled={total <= 0} className="btn-secondary">
                <ArrowRightLeft size={14} /> Perkelti
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                onClick={onWriteoff}
                disabled={total <= 0}
                className="btn-secondary border-signal-amber/30 text-signal-amber hover:bg-signal-amber/10"
              >
                <PackageMinus size={14} /> Nurašyti
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                onClick={onDelete}
                disabled={deletingId === part.id}
                className="btn-secondary border-signal-red/30 text-signal-red hover:bg-signal-red/10"
              >
                {deletingId === part.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                Ištrinti
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
              <>
                <ul className="space-y-1">
                  {writeoffHistory.slice(0, historyLimit).map((w) => (
                    <li
                      key={w.id}
                      className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs ${
                        w.undone_at ? "text-ink-600/40 line-through" : "text-ink-600/70"
                      }`}
                    >
                      <span>
                        <span className="font-semibold text-ink-800">-{w.quantity} vnt.</span>
                        {w.location && (
                          <>
                            {" · "}
                            {w.warehouses?.name && `${w.warehouses.name} — `}Lokacija {w.location}
                          </>
                        )}
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
                {writeoffHistory.length > HISTORY_PAGE_SIZE && (
                  <div className="mt-1.5 flex gap-3">
                    {historyLimit < writeoffHistory.length && (
                      <button
                        type="button"
                        onClick={() => setHistoryLimit((n) => n + HISTORY_PAGE_SIZE)}
                        className="text-xs font-medium text-signal-orange underline decoration-dotted hover:text-signal-orange/80"
                      >
                        Rodyti daugiau ({writeoffHistory.length - historyLimit} liko)
                      </button>
                    )}
                    {historyLimit > HISTORY_PAGE_SIZE && (
                      <button
                        type="button"
                        onClick={() => setHistoryLimit(HISTORY_PAGE_SIZE)}
                        className="text-xs font-medium text-ink-600/60 underline decoration-dotted hover:text-ink-900"
                      >
                        Rodyti mažiau
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function WriteoffModal({ part, onClose, onSave }) {
  const locations = (part.part_stock || []).filter((s) => (s.quantity ?? 0) > 0);
  const [stockId, setStockId] = useState(locations[0]?.id || "");
  const [quantity, setQuantity] = useState("1");
  const [reasonType, setReasonType] = useState("");
  const [price, setPrice] = useState("");
  const [priceTouched, setPriceTouched] = useState(false); // true, kai vartotojas pats redagavo kainą
  const [rma, setRma] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const selectedStock = locations.find((s) => s.id === stockId);

  // Pasirinkus "parduota", kaina automatiškai = priedo kaina × kiekis — TIK
  // kol vartotojas jos pats nepataisė (priceTouched).
  useEffect(() => {
    if (reasonType !== "parduota" || priceTouched || part.price == null) return;
    const qty = Math.round(Number(quantity));
    if (!qty || qty <= 0) return;
    setPrice((part.price * qty).toFixed(2));
  }, [reasonType, quantity, part.price, priceTouched]);

  async function submit(e) {
    e.preventDefault();
    if (!stockId) {
      setError("Pasirinkite sandėlį/lokaciją.");
      return;
    }
    const value = Math.round(Number(quantity));
    if (!value || value <= 0) {
      setError("Įveskite teigiamą kiekį.");
      return;
    }
    if (value > (selectedStock?.quantity ?? 0)) {
      setError(`Negalima nurašyti daugiau nei turima šioje vietoje (${selectedStock?.quantity ?? 0}).`);
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
      stockId,
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
          {part.name || part.part_code} — iš viso likutyje: <span className="font-semibold text-ink-800">{totalQuantity(part)}</span>
        </p>

        <div className="space-y-3">
          {locations.length === 0 ? (
            <p className="flex items-center gap-1.5 text-sm font-medium text-signal-red">
              <AlertCircle size={16} className="shrink-0" /> Nėra vietos su likučiu — nėra ko nurašyti.
            </p>
          ) : (
            <>
              <div>
                <label className="mb-1 block text-xs font-semibold text-ink-600/70">Sandėlis / lokacija</label>
                <select
                  value={stockId}
                  onChange={(e) => { setStockId(e.target.value); setQuantity("1"); }}
                  className="input-field"
                  required
                >
                  {locations.map((s) => (
                    <option key={s.id} value={s.id}>{placeLabel(s)} ({s.quantity ?? 0} vnt.)</option>
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
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">Kaina už visą nurašomą kiekį (€)</label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => { setPrice(e.target.value); setPriceTouched(true); }}
                className="input-field"
                required
              />
              <p className="mt-1 text-xs text-ink-600/50">
                Bendra suma už {Number(quantity) || 0} vnt., ne kaina už vienetą.
                {part.price != null && !priceTouched && " Užpildyta automatiškai iš priedo kainos — galite keisti."}
              </p>
            </div>
          )}

          {reasonType === "remontui" && (
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">RMA numeris</label>
              <input value={rma} onChange={(e) => setRma(e.target.value)} className="input-field" required />
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
          <button type="submit" disabled={saving || locations.length === 0} className="btn-primary">
            {saving && <Loader2 size={15} className="animate-spin" />}
            Nurašyti
          </button>
        </div>
      </form>
    </div>
  );
}

const NEW_PLACE = "__new__";

// Kiekio perkėlimas iš vienos priedo vietos į kitą: į esamą to paties
// priedo vietą (kiekiai susideda) arba į naują (bet kuris sandėlis +
// lokacija). Perkėlus visą kiekį šaltinio vieta išnyksta (žr.
// transfer_part_stock() migrate_parts_split_stock.sql).
function PartTransferModal({ part, onClose, onSave }) {
  const stock = part.part_stock || [];
  const sources = stock.filter((s) => (s.quantity ?? 0) > 0);
  const [fromStockId, setFromStockId] = useState(sources[0]?.id || "");
  const [quantity, setQuantity] = useState("1");
  const [target, setTarget] = useState(NEW_PLACE); // part_stock.id arba NEW_PLACE
  const [newWarehouseId, setNewWarehouseId] = useState(sources[0]?.warehouse_id || "");
  const [newLocation, setNewLocation] = useState("");
  const [warehouses, setWarehouses] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const source = sources.find((s) => s.id === fromStockId);
  const targets = stock.filter((s) => s.id !== fromStockId);

  useEffect(() => {
    let active = true;
    supabase.from("warehouses").select("id, name").order("name").then(({ data }) => {
      if (!active) return;
      const list = data || [];
      setWarehouses(list);
      setNewWarehouseId((prev) => prev || list[0]?.id || "");
    });
    return () => {
      active = false;
    };
  }, []);

  // Naujos vietos sandėlis numatytai — tas pats, kaip šaltinio.
  useEffect(() => {
    if (source?.warehouse_id) setNewWarehouseId(source.warehouse_id);
  }, [source?.warehouse_id]);

  async function submit(e) {
    e.preventDefault();
    if (!source) {
      setError("Pasirinkite, iš kur perkelti.");
      return;
    }
    const value = Math.round(Number(quantity));
    if (!Number.isFinite(value) || value <= 0) {
      setError("Įveskite teigiamą kiekį.");
      return;
    }
    if (value > (source.quantity ?? 0)) {
      setError(`Negalima perkelti daugiau nei turima (${source.quantity ?? 0}).`);
      return;
    }
    let toWarehouseId;
    let toLocation;
    if (target === NEW_PLACE) {
      toWarehouseId = newWarehouseId;
      toLocation = newLocation.trim();
      if (!toWarehouseId) {
        setError("Pasirinkite sandėlį.");
        return;
      }
      if (!toLocation) {
        setError("Įveskite lokaciją.");
        return;
      }
    } else {
      const t = stock.find((s) => s.id === target);
      toWarehouseId = t.warehouse_id;
      toLocation = t.location;
    }
    setSaving(true);
    setError("");
    const errorMessage = await onSave({ fromStockId, toWarehouseId, toLocation, quantity: value });
    setSaving(false);
    if (errorMessage) setError(errorMessage);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink-950/50 p-0 sm:items-center sm:p-4">
      <form onSubmit={submit} className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-panel sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">Perkelti priedą</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-ink-900/5">
            <X size={18} />
          </button>
        </div>

        <p className="mb-3 text-sm text-ink-600/70">
          {part.name || part.part_code} (<span className="font-mono">{part.part_code}</span>)
        </p>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Iš kur</label>
            <select
              value={fromStockId}
              onChange={(e) => {
                setFromStockId(e.target.value);
                setQuantity("1");
                if (target === e.target.value) setTarget(NEW_PLACE);
              }}
              className="input-field"
              required
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>{placeLabel(s)} ({s.quantity ?? 0} vnt.)</option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Kiekis</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={source?.quantity ?? undefined}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="input-field"
                required
              />
              <button
                type="button"
                onClick={() => setQuantity(String(source?.quantity ?? 0))}
                className="btn-secondary shrink-0 px-2.5 py-2 text-xs"
              >
                Visus ({source?.quantity ?? 0})
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Į kur</label>
            <select value={target} onChange={(e) => setTarget(e.target.value)} className="input-field">
              {targets.map((s) => (
                <option key={s.id} value={s.id}>{placeLabel(s)} (dabar {s.quantity ?? 0} vnt.)</option>
              ))}
              <option value={NEW_PLACE}>+ Nauja vieta…</option>
            </select>
          </div>

          {target === NEW_PLACE && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-ink-600/70">Sandėlis</label>
                <select
                  value={newWarehouseId}
                  onChange={(e) => setNewWarehouseId(e.target.value)}
                  className="input-field"
                  disabled={!warehouses}
                >
                  {(warehouses || []).map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-ink-600/70">Lokacija</label>
                <input
                  value={newLocation}
                  onChange={(e) => setNewLocation(e.target.value)}
                  placeholder="pvz. 42 (-7-)"
                  className="input-field"
                />
              </div>
            </div>
          )}

          {source && Math.round(Number(quantity)) === (source.quantity ?? 0) && target !== NEW_PLACE && (
            <p className="text-xs text-ink-600/60">
              Perkeliamas visas kiekis — vieta „{placeLabel(source)}“ bus sujungta su pasirinkta ir išnyks.
            </p>
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
          <button type="submit" disabled={saving || !sources.length} className="btn-primary">
            {saving && <Loader2 size={15} className="animate-spin" />}
            Perkelti
          </button>
        </div>
      </form>
    </div>
  );
}

// Kuriant (initial === null) — priedas + pirma vieta (sandėlis/lokacija/
// kiekis). Redaguojant — katalogo laukai + kiekvienos vietos sandėlis/
// lokacija, tuščios (0 vnt.) vietos pašalinimas ir naujų vietų pridėjimas.
// "Paruošti išsiuntimui" — sukuria darbą (tasks), priskirtą sandėlininkui
// (adminui). Likutis NEnurašomas — tai daroma atskirai, atkrovus.
function ShipTaskModal({ part, onClose, onSave }) {
  const total = totalQuantity(part);
  const [quantity, setQuantity] = useState("1");
  const [orderRef, setOrderRef] = useState("");
  const [unitPrice, setUnitPrice] = useState(part.price != null ? String(part.price) : "");
  const [note, setNote] = useState("");
  const [assignees, setAssignees] = useState(null); // null = dar kraunama
  const [assigneeId, setAssigneeId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    supabase.rpc("task_assignees").then(({ data, error: rpcError }) => {
      if (rpcError) setError(`Nepavyko įkelti gavėjų: ${rpcError.message}`);
      const list = data || [];
      setAssignees(list);
      setAssigneeId(list[0]?.id || "");
    });
  }, []);

  const qty = Number(quantity);
  const qtyValid = Number.isInteger(qty) && qty > 0;
  // Kaina nebūtina — jei vadybininkė jos nežino, ją įrašys sandėlininkas užbaigdamas.
  const priceRaw = unitPrice.trim().replace(",", ".");
  const priceNum = priceRaw === "" ? null : Number(priceRaw);
  const priceValid = priceNum === null || (Number.isFinite(priceNum) && priceNum > 0);

  async function submit(e) {
    e.preventDefault();
    if (!qtyValid) {
      setError("Kiekis turi būti teigiamas sveikas skaičius.");
      return;
    }
    if (!priceValid) {
      setError("Kaina turi būti teigiamas skaičius.");
      return;
    }
    setSaving(true);
    const errorMessage = await onSave({
      quantity: qty, orderRef: orderRef.trim(), unitPrice: priceNum, note: note.trim(), assigneeId
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
          <h2 className="text-base font-bold text-ink-900">Paruošti išsiuntimui</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-ink-900/5">
            <X size={18} />
          </button>
        </div>

        <p className="mb-3 text-sm text-ink-600/70">
          {part.name || part.part_code} — likutyje: <span className="font-semibold text-ink-800">{total}</span>
        </p>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Kiekis</label>
            <input
              type="number"
              min={1}
              step={1}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="input-field w-28"
              required
            />
            {qtyValid && qty > total && (
              <p className="mt-1 flex items-center gap-1 text-xs font-medium text-signal-amber">
                <AlertCircle size={13} /> Likutyje tik {total} vnt.
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Užsakymo nr. (nebūtina)</label>
            <input
              value={orderRef}
              onChange={(e) => setOrderRef(e.target.value)}
              placeholder="pvz. 10234"
              className="input-field"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pardavimo kaina už vnt. (nebūtina)</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step="0.01"
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value)}
                placeholder="Nežinoma"
                className="input-field w-32"
              />
              <span className="text-sm text-ink-600/50">€</span>
              {priceNum > 0 && qtyValid && qty > 1 && (
                <span className="text-xs text-ink-600/70">iš viso {(priceNum * qty).toFixed(2)} €</span>
              )}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pastaba (nebūtina)</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="pvz. Omniva paštomatas, skubu"
              className="input-field resize-none"
            />
          </div>
          {assignees?.length > 1 && (
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">Kam</label>
              <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className="input-field">
                {assignees.map((a) => (
                  <option key={a.id} value={a.id}>{a.username}</option>
                ))}
              </select>
            </div>
          )}
          {assignees?.length === 0 && !error && (
            <p className="text-xs font-medium text-signal-red">Nėra kam priskirti darbo — reikia bent vieno administratoriaus.</p>
          )}
          {assignees?.length === 1 && (
            <p className="text-xs text-ink-600/60">
              Darbas atsiras: <span className="font-semibold text-ink-800">{assignees[0].username}</span>
            </p>
          )}
          {error && (
            <p className="flex items-center gap-1.5 text-sm font-medium text-signal-red">
              <AlertCircle size={16} className="shrink-0" /> {error}
            </p>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Atšaukti
          </button>
          <button type="submit" disabled={saving || !assigneeId} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            Sukurti darbą
          </button>
        </div>
      </form>
    </div>
  );
}

function PartFormModal({ title, initial, onClose, onSave }) {
  const isCreating = !initial;
  const [form, setForm] = useState({
    main_model: initial?.main_model || "",
    name: initial?.name || "",
    part_code: initial?.part_code || "",
    min_quantity: initial?.min_quantity ?? "",
    compatible_models: initial?.compatible_models || "",
    online_store: !!initial?.online_store,
    warehouseId: "",
    location: "",
    quantity: "0",
    stock: (initial?.part_stock || []).map((s) => ({
      id: s.id,
      quantity: s.quantity ?? 0,
      warehouseId: s.warehouse_id,
      location: s.location,
      origWarehouseId: s.warehouse_id,
      origLocation: s.location,
      removed: false
    })),
    newStock: []
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [warehouses, setWarehouses] = useState(null); // null = dar kraunama

  // Kuriant numatytai parenkamas "Lidl servisas" (priedų sandėlis), jei yra.
  useEffect(() => {
    let active = true;
    supabase.from("warehouses").select("id, name").order("name").then(({ data }) => {
      if (!active) return;
      const list = data || [];
      setWarehouses(list);
      const lidl = list.find((w) => w.name.trim().toLowerCase() === "lidl servisas");
      setForm((prev) => (prev.warehouseId ? prev : { ...prev, warehouseId: (lidl ?? list[0])?.id || "" }));
    });
    return () => {
      active = false;
    };
  }, []);

  function updateStockRow(id, patch) {
    setForm((prev) => ({ ...prev, stock: prev.stock.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
  }

  function updateNewRow(index, patch) {
    setForm((prev) => ({ ...prev, newStock: prev.newStock.map((r, i) => (i === index ? { ...r, ...patch } : r)) }));
  }

  function addNewRow() {
    setForm((prev) => ({
      ...prev,
      newStock: [...prev.newStock, { warehouseId: prev.stock[0]?.warehouseId || prev.warehouseId || warehouses?.[0]?.id || "", location: "", quantity: "0" }]
    }));
  }

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
              placeholder="N/A, jei detalė neturi numerio"
              className="input-field font-mono"
            />
          </div>

          {isCreating && (
            <div className="space-y-3 border-t border-ink-900/5 pt-3">
              <p className="text-xs font-semibold text-ink-600/70">Vieta</p>
              <div>
                <label className="mb-1 block text-xs font-semibold text-ink-600/70">Sandėlis</label>
                <select
                  value={form.warehouseId}
                  onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}
                  className="input-field"
                  disabled={!warehouses}
                  required
                >
                  {warehouses && warehouses.length === 0 && <option value="">Sandėlių nėra — sukurkite /sandeliai</option>}
                  {(warehouses || []).map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-ink-600/70">Lokacija</label>
                  <input
                    value={form.location}
                    onChange={(e) => setForm({ ...form, location: e.target.value })}
                    placeholder="pvz. 42 (-7-)"
                    className="input-field"
                    required
                  />
                </div>
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
              </div>
            </div>
          )}

          {!isCreating && (
            <div className="space-y-2 border-t border-ink-900/5 pt-3">
              <p className="text-xs font-semibold text-ink-600/70">Vietos — sandėlis / lokacija</p>
              {form.stock.map((row) =>
                row.removed ? (
                  <div key={row.id} className="flex items-center justify-between gap-2 text-xs text-ink-600/50">
                    <span className="line-through">Lokacija {row.origLocation} — bus pašalinta</span>
                    <button
                      type="button"
                      onClick={() => updateStockRow(row.id, { removed: false })}
                      className="font-medium underline decoration-dotted hover:text-ink-900"
                    >
                      Grąžinti
                    </button>
                  </div>
                ) : (
                  <div key={row.id} className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2">
                    <select
                      value={row.warehouseId}
                      onChange={(e) => updateStockRow(row.id, { warehouseId: e.target.value })}
                      className="input-field"
                      disabled={!warehouses}
                      aria-label="Sandėlis"
                    >
                      {(warehouses || []).map((w) => (
                        <option key={w.id} value={w.id}>{w.name}</option>
                      ))}
                    </select>
                    <input
                      value={row.location}
                      onChange={(e) => updateStockRow(row.id, { location: e.target.value })}
                      placeholder="Lokacija"
                      className="input-field"
                      aria-label="Lokacija"
                    />
                    <span className="whitespace-nowrap text-xs text-ink-600/60">{row.quantity} vnt.</span>
                    <button
                      type="button"
                      onClick={() => updateStockRow(row.id, { removed: true })}
                      disabled={row.quantity > 0}
                      className="rounded-lg p-1 text-ink-600/40 hover:bg-signal-red/10 hover:text-signal-red disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-600/40"
                      aria-label="Pašalinti vietą"
                      title={row.quantity > 0 ? "Pašalinti galima tik tuščią (0 vnt.) vietą — kitaip perkelkite arba nurašykite" : "Pašalinti vietą"}
                    >
                      <X size={15} />
                    </button>
                  </div>
                )
              )}
              {form.newStock.map((row, i) => (
                <div key={`new-${i}`} className="grid grid-cols-[1fr_1fr_4rem_auto] items-center gap-2">
                  <select
                    value={row.warehouseId}
                    onChange={(e) => updateNewRow(i, { warehouseId: e.target.value })}
                    className="input-field"
                    disabled={!warehouses}
                    aria-label="Naujos vietos sandėlis"
                  >
                    {(warehouses || []).map((w) => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                  </select>
                  <input
                    value={row.location}
                    onChange={(e) => updateNewRow(i, { location: e.target.value })}
                    placeholder="Lokacija"
                    className="input-field"
                    aria-label="Naujos vietos lokacija"
                  />
                  <input
                    type="number"
                    min={0}
                    value={row.quantity}
                    onChange={(e) => updateNewRow(i, { quantity: e.target.value })}
                    className="input-field px-2"
                    aria-label="Naujos vietos kiekis"
                  />
                  <button
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, newStock: prev.newStock.filter((_, j) => j !== i) }))}
                    className="rounded-lg p-1 text-ink-600/40 hover:bg-ink-900/5 hover:text-ink-900"
                    aria-label="Atsisakyti naujos vietos"
                  >
                    <X size={15} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addNewRow}
                className="text-xs font-medium text-signal-orange underline decoration-dotted hover:text-signal-orange/80"
              >
                + Pridėti vietą
              </button>
              <p className="text-[11px] text-ink-600/50">
                Esamų vietų kiekis keičiamas sąraše (+/−), perkeliamas — per „Perkelti“.
              </p>
            </div>
          )}

          <div className="border-t border-ink-900/5 pt-3">
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Min. likutis (visam kiekiui)</label>
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
          <button type="submit" disabled={saving || (isCreating && !form.warehouseId)} className="btn-primary">
            {saving && <Loader2 size={15} className="animate-spin" />}
            Išsaugoti
          </button>
        </div>
      </form>
    </div>
  );
}
