import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Loader2, ChevronRight, Boxes, CheckCircle2,
  FileSpreadsheet, Send, Clock
} from "lucide-react";
import * as XLSX from "xlsx";
import { supabase } from "../lib/supabaseClient";

export default function Pallets() {
  const location = useLocation();
  const navigate = useNavigate();
  const [openShipment, setOpenShipment] = useState(null);
  const [shipmentMap, setShipmentMap] = useState({}); // shipment id -> shipment obj
  const [pallets, setPallets] = useState([]);          // visos closed paletės
  const [quantities, setQuantities] = useState({});    // pallet id -> sum(quantity)
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [marking, setMarking] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (location.state?.closedMessage) {
      setNotice(location.state.closedMessage);
      navigate(location.pathname, { replace: true, state: {} });
      const t = setTimeout(() => setNotice(""), 6000);
      return () => clearTimeout(t);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
    const channel = supabase
      .channel("pallets-full-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "pallets" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "shipments" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "items" }, load)
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  async function load() {
    setLoading(true);

    const { data: shipmentsData } = await supabase
      .from("shipments")
      .select("*")
      .order("created_at", { ascending: false });

    const sMap = {};
    (shipmentsData || []).forEach((s) => { sMap[s.id] = s; });
    const open = (shipmentsData || []).find((s) => s.status === "open") || null;

    const { data: palletData } = await supabase
      .from("pallets")
      .select("id, code, number, packed_at, shipment_id")
      .eq("status", "closed")
      .order("number", { ascending: false, nullsFirst: false });

    const palletIds = (palletData || []).map((p) => p.id);
    const qtys = {};
    if (palletIds.length > 0) {
      const { data: itemData } = await supabase
        .from("items")
        .select("pallet_id, quantity")
        .in("pallet_id", palletIds);
      (itemData || []).forEach((i) => {
        if (i.pallet_id) qtys[i.pallet_id] = (qtys[i.pallet_id] || 0) + (i.quantity || 1);
      });
    }

    setOpenShipment(open);
    setShipmentMap(sMap);
    setPallets(palletData || []);
    setQuantities(qtys);
    setLoading(false);
  }

  async function handleMarkSent() {
    if (!openShipment) return;
    if (!confirm("Pažymėti siuntą kaip išvežtą? Sekančios uždarytos paletės automatiškai pradės naują siuntą.")) return;
    setMarking(true);
    await supabase
      .from("shipments")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", openShipment.id);
    setMarking(false);
  }

  async function downloadExcel() {
    if (!openShipment) return;
    setDownloading(true);

    const openPallets = pallets
      .filter((p) => p.shipment_id === openShipment.id)
      .sort((a, b) => (a.number || 0) - (b.number || 0));

    const palletIds = openPallets.map((p) => p.id);
    let itemsData = [];
    if (palletIds.length > 0) {
      const { data } = await supabase
        .from("items")
        .select("pallet_id, ian, name, quantity")
        .in("pallet_id", palletIds);
      itemsData = data || [];
    }

    const rows = [["Paletės Nr", "Supakavimo data", "Pavadinimas", "Kiekis", "IAN kodai"]];
    for (const p of openPallets) {
      const palletItems = itemsData.filter((i) => i.pallet_id === p.id);
      const byName = new Map();
      for (const item of palletItems) {
        const key = item.name || "(be pavadinimo)";
        if (!byName.has(key)) byName.set(key, { totalQty: 0, ians: [] });
        const entry = byName.get(key);
        entry.totalQty += item.quantity || 1;
        entry.ians.push(item.ian);
      }
      if (byName.size === 0) {
        rows.push([palletLabel(p), formatDate(p.packed_at), "(tuščia paletė)", 0, ""]);
      } else {
        for (const [name, { totalQty, ians }] of byName.entries()) {
          rows.push([palletLabel(p), formatDate(p.packed_at), name, totalQty, ians.join("; ")]);
        }
      }
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 14 }, { wch: 16 }, { wch: 42 }, { wch: 8 }, { wch: 60 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Siunta");
    XLSX.writeFile(wb, `${openShipment.code}.xlsx`);
    setDownloading(false);
  }

  function palletLabel(p) {
    return p.number ? `${p.number} paletė` : p.code;
  }

  function formatDate(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleDateString("lt-LT");
  }

  const openShipmentPallets = pallets.filter((p) => p.shipment_id === openShipment?.id);
  const openShipmentQty = openShipmentPallets.reduce((s, p) => s + (quantities[p.id] || 0), 0);
  const hasPending = openShipmentPallets.length > 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Paletės</h1>
        <p className="mt-1 text-sm text-ink-600/70">
          Išvežimo suvestinė ir visų uždarytų paletžų istorija.
        </p>
      </div>

      {notice && (
        <div className="flex items-center gap-2 rounded-xl border border-signal-teal/20 bg-signal-teal/5 px-4 py-3 text-sm font-medium text-signal-teal">
          <CheckCircle2 size={16} className="shrink-0" />
          {notice}
        </div>
      )}

      {/* Dabartinės siuntos suvestinė */}
      {loading ? (
        <div className="flex justify-center py-6 text-ink-600/50">
          <Loader2 className="animate-spin" size={20} />
        </div>
      ) : hasPending ? (
        <div className="panel space-y-4 p-4 lg:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-mono uppercase tracking-widest text-ink-600/50">
                Laukia išvežimo
              </p>
              <p className="mt-0.5 font-mono text-lg font-bold text-ink-900">
                {openShipment.code}
              </p>
              <p className="mt-1 text-sm text-ink-600/70">
                {openShipmentPallets.length} paletė(-ių) &middot; {openShipmentQty} vnt.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={downloadExcel}
                disabled={downloading}
                className="btn-secondary"
              >
                {downloading
                  ? <Loader2 size={15} className="animate-spin" />
                  : <FileSpreadsheet size={15} />}
                Atsisiųsti Excel
              </button>
              <button
                onClick={handleMarkSent}
                disabled={marking}
                className="btn-primary"
              >
                {marking
                  ? <Loader2 size={15} className="animate-spin" />
                  : <Send size={15} />}
                Pažymėti kaip išvežta
              </button>
            </div>
          </div>
        </div>
      ) : (
        !loading && (
          <div className="panel flex items-center gap-3 p-4 text-sm text-ink-600/60">
            <Clock size={16} className="shrink-0 text-ink-600/30" />
            Nėra paletžų, laukiančių išvežimo.
          </div>
        )
      )}

      {/* Visų uždarytų paletžų sąrašas */}
      {!loading && pallets.length === 0 ? (
        <div className="panel flex flex-col items-center gap-2 py-12 text-center">
          <Boxes className="text-ink-600/30" size={28} />
          <p className="text-sm text-ink-600/60">Dar nėra uždarytų paletžų.</p>
        </div>
      ) : !loading && (
        <div className="panel overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-900/5 bg-ink-900/[0.02] text-xs uppercase tracking-wide text-ink-600/60">
              <tr>
                <th className="px-4 py-3 font-semibold">Paletė</th>
                <th className="px-4 py-3 font-semibold">Uždarymo data</th>
                <th className="px-4 py-3 font-semibold">Vnt.</th>
                <th className="px-4 py-3 font-semibold">Siunta</th>
                <th className="px-4 py-3 font-semibold"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-900/5">
              {pallets.map((p) => {
                const isOpen = openShipment && p.shipment_id === openShipment.id;
                const shipment = shipmentMap[p.shipment_id];
                return (
                  <tr
                    key={p.id}
                    className={isOpen
                      ? "bg-signal-amber/[0.04] hover:bg-signal-amber/[0.07]"
                      : "hover:bg-ink-900/[0.015]"}
                  >
                    <td className="px-4 py-3 font-semibold text-ink-900">{palletLabel(p)}</td>
                    <td className="px-4 py-3 text-ink-600/70">{formatDate(p.packed_at)}</td>
                    <td className="px-4 py-3 font-mono text-ink-800">{quantities[p.id] || 0}</td>
                    <td className="px-4 py-3">
                      {isOpen ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-signal-amber/30 bg-signal-amber/15 px-2.5 py-0.5 text-xs font-semibold text-[#8a5b10]">
                          <Clock size={10} />
                          Laukia
                        </span>
                      ) : shipment?.sent_at ? (
                        <span className="text-xs text-signal-teal">
                          Išvežta {formatDate(shipment.sent_at)}
                        </span>
                      ) : (
                        <span className="text-xs text-ink-600/40">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        to={`/paletes/${p.id}`}
                        className="inline-flex items-center gap-1 text-xs font-medium text-signal-orange hover:underline"
                      >
                        Peržiūrėti <ChevronRight size={13} />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
