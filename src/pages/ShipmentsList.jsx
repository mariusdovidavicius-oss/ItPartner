import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2, FileSpreadsheet, Eye, Boxes, AlertCircle, Search } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { prettifyDestination, UNCLASSIFIED } from "../lib/destination";
import DestinationBadge from "../components/DestinationBadge";
import { escapeLike, formatDate } from "../lib/format";

// Stulpeliai su įdėtais pallets/shipments duomenimis — "!inner" užtikrina, kad
// grąžinami tik prietaisai, kurie priklauso jau IŠVEŽTAI paletei (t. y. turi
// shipment_id), nes tik tokia paletė turi susietą shipments įrašą.
const SEARCH_SELECT =
  "id, ian, name, quantity, pallet_id, pallets!inner(id, number, code, destination, packed_at, shipment_id, shipments!inner(id, code, sent_at, destination))";

export default function ShipmentsList() {
  const navigate = useNavigate();
  const [shipments, setShipments] = useState([]);
  const [palletCounts, setPalletCounts] = useState({}); // shipment id -> palečių skaičius
  const [quantities, setQuantities] = useState({});     // shipment id -> vnt. suma
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState("all");
  const [downloadingId, setDownloadingId] = useState(null);
  const [notice, setNotice] = useState("");

  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    load();
    const channel = supabase
      .channel("shipments-list-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "shipments" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "pallets" }, load)
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  async function load() {
    setLoading(true);
    const { data: shipmentsData } = await supabase
      .from("shipments")
      .select("*")
      .eq("status", "sent")
      .order("sent_at", { ascending: false });

    const list = shipmentsData || [];
    const shipmentIds = list.map((s) => s.id);

    const counts = {};
    const qtys = {};
    if (shipmentIds.length > 0) {
      const { data: palletData } = await supabase
        .from("pallets")
        .select("id, shipment_id")
        .in("shipment_id", shipmentIds);

      const palletList = palletData || [];
      const shipmentByPallet = {};
      palletList.forEach((p) => {
        shipmentByPallet[p.id] = p.shipment_id;
        counts[p.shipment_id] = (counts[p.shipment_id] || 0) + 1;
      });

      const palletIds = palletList.map((p) => p.id);
      if (palletIds.length > 0) {
        const { data: itemData } = await supabase
          .from("items")
          .select("pallet_id, quantity")
          .in("pallet_id", palletIds);
        (itemData || []).forEach((i) => {
          const sId = shipmentByPallet[i.pallet_id];
          if (!sId) return;
          qtys[sId] = (qtys[sId] || 0) + (i.quantity || 1);
        });
      }
    }

    setShipments(list);
    setPalletCounts(counts);
    setQuantities(qtys);
    setLoading(false);
  }

  // Prietaiso paieška pagal IAN arba pavadinimą VISOSE išvežtose siuntose —
  // padeda rasti, kurioje siuntoje ir paletėje yra konkretus prietaisas.
  // Užklausiama tiesiai iš serverio (su debounce), nes bendras išvežtų
  // prietaisų kiekis gali būti didelis.
  useEffect(() => {
    const trimmed = search.trim();
    if (!trimmed) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      const q = escapeLike(trimmed);
      const [byIan, byName] = await Promise.all([
        supabase.from("items").select(SEARCH_SELECT).ilike("ian", `%${q}%`).limit(30),
        supabase.from("items").select(SEARCH_SELECT).ilike("name", `%${q}%`).limit(30)
      ]);
      const merged = new Map();
      [...(byIan.data || []), ...(byName.data || [])].forEach((item) => merged.set(item.id, item));
      setSearchResults(Array.from(merged.values()));
      setSearching(false);
    }, 350);
    return () => clearTimeout(handle);
  }, [search]);

  const destinationFilters = useMemo(() => {
    const set = new Set();
    shipments.forEach((s) => set.add(s.destination || UNCLASSIFIED));
    const sorted = Array.from(set).sort((a, b) => prettifyDestination(a).localeCompare(prettifyDestination(b)));
    return [{ value: "all", label: "Visos" }, ...sorted.map((d) => ({ value: d, label: prettifyDestination(d) }))];
  }, [shipments]);

  const filtered = useMemo(
    () => shipments.filter((s) => activeFilter === "all" || s.destination === activeFilter),
    [shipments, activeFilter]
  );

  async function handleDownload(shipment) {
    setDownloadingId(shipment.id);
    setNotice("");
    const { data: palletData } = await supabase
      .from("pallets")
      .select("id, code, number, destination, packed_at")
      .eq("shipment_id", shipment.id);
    const { exportPalletsToExcel } = await import("../lib/exportExcel");
    const result = await exportPalletsToExcel(palletData || [], `${shipment.code}.xlsx`);
    if (!result.ok) setNotice(result.message);
    setDownloadingId(null);
  }

  return (
    <div className="space-y-5">
      <button
        onClick={() => navigate("/paletes")}
        className="flex items-center gap-1.5 text-sm font-medium text-ink-600/70 hover:text-ink-900"
      >
        <ArrowLeft size={15} /> Paletės
      </button>

      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Visos siuntos</h1>
        <p className="mt-1 text-sm text-ink-600/70">Iš viso {shipments.length} išvežtų siuntų.</p>
      </div>

      {notice && (
        <p className="flex items-center gap-1.5 text-xs text-signal-red">
          <AlertCircle size={13} /> {notice}
        </p>
      )}

      <div className="relative">
        <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-600/40" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Ieškoti prietaiso pagal IAN arba pavadinimą visose siuntose…"
          className="input-field pl-10"
        />
        {searching && (
          <Loader2
            size={16}
            className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 animate-spin text-ink-600/30"
          />
        )}
      </div>

      {search.trim() ? (
        searching ? (
          <div className="flex justify-center py-6 text-ink-600/50">
            <Loader2 className="animate-spin" size={20} />
          </div>
        ) : searchResults.length === 0 ? (
          <div className="panel p-4 text-center text-sm text-ink-600/50">
            Nerasta jokio prietaiso pagal „{search.trim()}“.
          </div>
        ) : (
          <div className="panel divide-y divide-ink-900/5 p-4 lg:p-5">
            {searchResults.map((item) => {
              const pallet = item.pallets;
              const shipment = pallet?.shipments;
              return (
                <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm font-semibold text-ink-900">{item.ian}</p>
                    {item.name && <p className="truncate text-xs text-ink-600/60">{item.name}</p>}
                    <p className="mt-1 text-xs text-ink-600/60">
                      {pallet?.number ? `${pallet.number} paletė` : pallet?.code}
                      {shipment && (
                        <>
                          {" "}&middot; {shipment.code} &middot; Išvežta {formatDate(shipment.sent_at)}
                        </>
                      )}
                    </p>
                  </div>
                  {shipment && (
                    <Link
                      to={`/siuntos/${shipment.id}?q=${encodeURIComponent(item.ian)}`}
                      className="btn-secondary shrink-0"
                    >
                      <Eye size={14} /> Peržiūrėti
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-600/50">Paskirtis</span>
            <div className="inline-flex flex-wrap rounded-xl border border-ink-700/15 bg-white p-1 text-sm font-medium">
              {destinationFilters.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setActiveFilter(opt.value)}
                  className={
                    activeFilter === opt.value
                      ? "rounded-lg bg-ink-950 px-3.5 py-1.5 text-white"
                      : "rounded-lg px-3.5 py-1.5 text-ink-600/70 hover:text-ink-900"
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="panel p-4 lg:p-5">
            {loading ? (
              <div className="flex justify-center py-6 text-ink-600/50">
                <Loader2 className="animate-spin" size={20} />
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <Boxes className="text-ink-600/30" size={24} />
                <p className="text-sm text-ink-600/60">Siuntų nerasta.</p>
              </div>
            ) : (
              <div className="divide-y divide-ink-900/5">
                {filtered.map((s) => (
                  <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div>
                      <p className="font-mono text-sm font-semibold text-ink-900">
                        {s.code}
                        <DestinationBadge destination={s.destination} />
                      </p>
                      <p className="text-xs text-ink-600/60">
                        Išvežta {formatDate(s.sent_at)} &middot; {palletCounts[s.id] || 0} paletė(-ių) &middot;{" "}
                        {quantities[s.id] || 0} vnt.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={`/siuntos/${s.id}`} className="btn-secondary">
                        <Eye size={14} /> Peržiūrėti
                      </Link>
                      <button
                        type="button"
                        onClick={() => handleDownload(s)}
                        disabled={downloadingId === s.id || (palletCounts[s.id] || 0) === 0}
                        className="btn-secondary"
                      >
                        {downloadingId === s.id
                          ? <Loader2 size={14} className="animate-spin" />
                          : <FileSpreadsheet size={14} />}
                        Atsisiųsti Excel
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
