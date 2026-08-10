import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft, Loader2, FileSpreadsheet, Printer, ChevronDown, ChevronUp, Boxes, AlertCircle, Search
} from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { prettifyDestination } from "../lib/destination";
import { exportPalletsToExcel } from "../lib/exportExcel";
import { printPalletLabels } from "../lib/printLabel";

function formatDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("lt-LT");
}

export default function ShipmentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [shipment, setShipment] = useState(null);
  const [pallets, setPallets] = useState([]);
  const [itemsByPallet, setItemsByPallet] = useState({});
  const [loading, setLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [downloading, setDownloading] = useState(false);
  const [notice, setNotice] = useState("");
  // Prefil'inama iš "?q=" URL parametro — leidžia atkeliauti tiesiai iš
  // /siuntos paieškos jau su surastu IAN įvestu paieškos lauke.
  const [search, setSearch] = useState(() => searchParams.get("q") || "");

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function load() {
    setLoading(true);
    const { data: s } = await supabase.from("shipments").select("*").eq("id", id).single();
    const { data: palletData } = await supabase
      .from("pallets")
      .select("id, code, number, destination, packed_at")
      .eq("shipment_id", id)
      .order("number", { ascending: true });

    const palletList = palletData || [];
    const palletIds = palletList.map((p) => p.id);
    const itemsMap = {};
    if (palletIds.length > 0) {
      const { data: items } = await supabase
        .from("items")
        .select("id, ian, name, quantity, pallet_id")
        .in("pallet_id", palletIds)
        .order("created_at", { ascending: true });
      (items || []).forEach((it) => {
        if (!it.pallet_id) return;
        (itemsMap[it.pallet_id] ||= []).push(it);
      });
    }

    setShipment(s);
    setPallets(palletList);
    setItemsByPallet(itemsMap);
    setLoading(false);
  }

  function toggleExpand(palletId) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(palletId)) next.delete(palletId);
      else next.add(palletId);
      return next;
    });
  }

  const totalQty = useMemo(
    () => Object.values(itemsByPallet).flat().reduce((s, i) => s + (i.quantity || 1), 0),
    [itemsByPallet]
  );

  // Paieška pagal IAN arba pavadinimą — leidžia rasti, kurioje paletėje yra
  // konkretus prietaisas. Ieškant rodomos tik atitikmenų turinčios paletės,
  // jos automatiškai išskleidžiamos, o atitikę įrašai paryškinami.
  const normalizedSearch = search.trim().toLowerCase();

  function itemMatches(item) {
    if (!normalizedSearch) return false;
    return (
      (item.ian || "").toLowerCase().includes(normalizedSearch) ||
      (item.name || "").toLowerCase().includes(normalizedSearch)
    );
  }

  const visiblePallets = useMemo(() => {
    if (!normalizedSearch) return pallets;
    return pallets.filter((p) => (itemsByPallet[p.id] || []).some((item) => itemMatches(item)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pallets, itemsByPallet, normalizedSearch]);

  async function handleDownload() {
    if (!shipment || pallets.length === 0) return;
    setDownloading(true);
    setNotice("");
    const result = await exportPalletsToExcel(pallets, `${shipment.code}.xlsx`);
    if (!result.ok) setNotice(result.message);
    setDownloading(false);
  }

  function handlePrint() {
    if (pallets.length === 0) return;
    printPalletLabels(pallets);
  }

  if (loading || !shipment) {
    return (
      <div className="flex justify-center py-10 text-ink-600/50">
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <button
        onClick={() => navigate("/paletes")}
        className="flex items-center gap-1.5 text-sm font-medium text-ink-600/70 hover:text-ink-900"
      >
        <ArrowLeft size={15} /> Visos paletės
      </button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-mono text-xl font-bold text-ink-900 lg:text-2xl">{shipment.code}</h1>
          <p className="mt-1 text-sm text-ink-600/70">
            {prettifyDestination(shipment.destination)} &middot; Išvežta {formatDate(shipment.sent_at)} &middot;{" "}
            {pallets.length} paletė(-ių) &middot; {totalQty} vnt.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handlePrint}
            disabled={pallets.length === 0}
            className="btn-secondary"
          >
            <Printer size={15} /> Spausdinti etiketes
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={downloading || pallets.length === 0}
            className="btn-secondary"
          >
            {downloading ? <Loader2 size={15} className="animate-spin" /> : <FileSpreadsheet size={15} />}
            Atsisiųsti Excel
          </button>
        </div>
      </div>

      {notice && (
        <p className="flex items-center gap-1.5 text-xs text-signal-red">
          <AlertCircle size={13} /> {notice}
        </p>
      )}

      {pallets.length === 0 ? (
        <div className="panel flex flex-col items-center gap-2 py-10 text-center">
          <Boxes className="text-ink-600/30" size={24} />
          <p className="text-sm text-ink-600/60">Šioje siuntoje palečių nėra.</p>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-600/40" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Ieškoti prietaiso pagal IAN arba pavadinimą…"
              className="input-field pl-10"
            />
          </div>

          {normalizedSearch && visiblePallets.length === 0 ? (
            <div className="panel p-4 text-center text-sm text-ink-600/50">
              Nerasta jokio prietaiso pagal „{search.trim()}“.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {visiblePallets.map((p) => {
                const expanded = normalizedSearch ? true : expandedIds.has(p.id);
                const palletItems = itemsByPallet[p.id] || [];
                const qty = palletItems.reduce((s, i) => s + (i.quantity || 1), 0);
                return (
                  <div key={p.id} className="panel space-y-3 p-3.5">
                    <button
                      type="button"
                      onClick={() => toggleExpand(p.id)}
                      disabled={!!normalizedSearch}
                      className="flex w-full items-center justify-between gap-3 disabled:cursor-default"
                    >
                      <div className="min-w-0 text-left">
                        <p className="truncate text-sm font-bold text-ink-900">
                          {p.number ? `${p.number} paletė` : p.code}
                        </p>
                        <p className="text-xs text-ink-600/60">
                          {qty} vnt. &middot; uždaryta {formatDate(p.packed_at)}
                        </p>
                      </div>
                      {!normalizedSearch && (
                        expanded
                          ? <ChevronUp size={16} className="shrink-0 text-ink-600/50" />
                          : <ChevronDown size={16} className="shrink-0 text-ink-600/50" />
                      )}
                    </button>

                    {expanded && (
                      <div className="overflow-hidden rounded-xl border border-ink-700/10">
                        {palletItems.length === 0 ? (
                          <p className="p-3 text-center text-xs text-ink-600/50">Prietaisų nėra.</p>
                        ) : (
                          <div className="divide-y divide-ink-900/5">
                            {palletItems.map((item) => (
                              <div
                                key={item.id}
                                className={`flex items-center justify-between gap-2 p-2.5 ${
                                  itemMatches(item) ? "bg-signal-orange/10" : ""
                                }`}
                              >
                                <div className="min-w-0">
                                  <p className="truncate font-mono text-xs font-medium text-ink-900">{item.ian}</p>
                                  {item.name && <p className="truncate text-xs text-ink-600/60">{item.name}</p>}
                                </div>
                                <span className="shrink-0 text-xs font-medium text-ink-600/50">
                                  {item.quantity || 1} vnt.
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
