import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Loader2, ChevronRight, Boxes, CheckCircle2,
  FileSpreadsheet, Send, Clock, CheckSquare, Square, PackageCheck, Printer, Eye
} from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { prettifyDestination, splitDestination, UNCLASSIFIED } from "../lib/destination";
import { printPalletLabel, printPalletLabels } from "../lib/printLabel";
import DestinationBadge from "../components/DestinationBadge";
import { useAuth } from "../lib/AuthProvider";
import { formatDate } from "../lib/format";

export default function Pallets() {
  const location = useLocation();
  const navigate = useNavigate();
  const { hasPalletPermission } = useAuth();
  const canShip = hasPalletPermission("ship");

  // Visos "closed" + "ready" paletės (abiejų reikia, kad būtų galima
  // sudėlioti tiek "Laukia paruošimo" / "Paruošta išvežimui" sąrašus, tiek
  // teisingai priskirti jau išvežtas paletes prie istorijoje rodomos siuntos).
  const [pallets, setPallets] = useState([]);
  const [shipments, setShipments] = useState([]);   // visos išsiųstos (status='sent') siuntos
  const [quantities, setQuantities] = useState({}); // pallet id -> sum(quantity)
  const [loading, setLoading] = useState(true);

  const [selectedClosed, setSelectedClosed] = useState(new Set()); // "Laukia paruošimo" pažymėjimas
  const [selectedReady, setSelectedReady] = useState(new Set());   // "Paruošta išvežimui" pažymėjimas

  const [activeFilter, setActiveFilter] = useState("all"); // 'all' arba konkreti destination reikšmė
  const [downloading, setDownloading] = useState(false);
  const [markingReady, setMarkingReady] = useState(false);
  const [marking, setMarking] = useState(false);
  const [historyDownloadingId, setHistoryDownloadingId] = useState(null);
  const [notice, setNotice] = useState("");
  const [shipmentHistoryLimit, setShipmentHistoryLimit] = useState(5);

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

  // Pasirinkimą laikom tik vienos paskirties viduje — keičiant filtrą jį išvalome,
  // kad neliktų pažymėtų palečių iš dabar nebematomos paskirties.
  useEffect(() => {
    setSelectedClosed(new Set());
    setSelectedReady(new Set());
    setShipmentHistoryLimit(5);
  }, [activeFilter]);

  async function load() {
    setLoading(true);

    const { data: shipmentsData } = await supabase
      .from("shipments")
      .select("*")
      .eq("status", "sent")
      .order("sent_at", { ascending: false });

    const { data: palletData } = await supabase
      .from("pallets")
      .select("id, code, number, status, packed_at, shipment_id, destination")
      .in("status", ["closed", "ready"])
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

    setShipments(shipmentsData || []);
    setPallets(palletData || []);
    setQuantities(qtys);

    // Pašalina iš pažymėjimo paletes, kurios tarp perkrovimų nebeliko
    // atitinkamos būsenos (pvz. jau paskirta ready/pažymėta sent kito lango).
    const stillClosedIds = new Set(
      (palletData || []).filter((p) => p.status === "closed" && !p.shipment_id).map((p) => p.id)
    );
    const stillReadyIds = new Set(
      (palletData || []).filter((p) => p.status === "ready" && !p.shipment_id).map((p) => p.id)
    );
    setSelectedClosed((prev) => {
      const next = new Set();
      prev.forEach((id) => { if (stillClosedIds.has(id)) next.add(id); });
      return next;
    });
    setSelectedReady((prev) => {
      const next = new Set();
      prev.forEach((id) => { if (stillReadyIds.has(id)) next.add(id); });
      return next;
    });

    setLoading(false);
  }

  const closedPallets = useMemo(
    () => pallets.filter((p) => p.status === "closed" && !p.shipment_id),
    [pallets]
  );
  const readyPallets = useMemo(
    () => pallets.filter((p) => p.status === "ready" && !p.shipment_id),
    [pallets]
  );

  // Filtro mygtukai generuojami dinamiškai iš to, kas realiai yra duomenyse —
  // jokio fiksuoto sąrašo, naujos paskirtys atsiranda automatiškai.
  // Filtro mygtukai rodomi TIK toms paskirtims, kurios dar turi laukiančių/paruoštų
  // (t. y. neišvežtų) palečių — jei visos konkrečios paskirties paletės jau
  // išvežtos, jos mygtukas filtro juostoje nebesirodo.
  const destinationFilters = useMemo(() => {
    const set = new Set();
    closedPallets.forEach((p) => set.add(p.destination || UNCLASSIFIED));
    readyPallets.forEach((p) => set.add(p.destination || UNCLASSIFIED));
    const sorted = Array.from(set).sort((a, b) =>
      prettifyDestination(a).localeCompare(prettifyDestination(b))
    );
    return [
      { value: "all", label: "Visos" },
      ...sorted.map((d) => ({ value: d, label: prettifyDestination(d) }))
    ];
  }, [closedPallets, readyPallets]);

  // Jei aktyviai pasirinkta paskirtis dingsta iš filtro juostos (jos paskutinė
  // paletė ką tik buvo išvežta), grąžiname į "Visos", kad neliktų "pakibusio"
  // filtro be matomo aktyvaus mygtuko.
  useEffect(() => {
    if (activeFilter !== "all" && !destinationFilters.some((f) => f.value === activeFilter)) {
      setActiveFilter("all");
    }
  }, [destinationFilters, activeFilter]);

  const closedPalletsFiltered = useMemo(
    () => closedPallets.filter((p) => activeFilter === "all" || p.destination === activeFilter),
    [closedPallets, activeFilter]
  );

  const readyPalletsFiltered = useMemo(
    () => readyPallets.filter((p) => activeFilter === "all" || p.destination === activeFilter),
    [readyPallets, activeFilter]
  );

  const shipmentsFiltered = useMemo(
    () => shipments.filter((s) => activeFilter === "all" || s.destination === activeFilter),
    [shipments, activeFilter]
  );

  const visibleShipments = useMemo(
    () => shipmentsFiltered.slice(0, shipmentHistoryLimit),
    [shipmentsFiltered, shipmentHistoryLimit]
  );

  const shipmentPalletsMap = useMemo(() => {
    const map = {};
    pallets.forEach((p) => {
      if (p.shipment_id) {
        (map[p.shipment_id] ||= []).push(p);
      }
    });
    return map;
  }, [pallets]);

  // Pasirinkimas galimas tik kai peržiūrima konkreti paskirtis — taip niekada
  // negalima pažymėti palečių iš skirtingų paskirčių vienu metu (nei paruošimui,
  // nei siuntai formuoti).
  const selectionDisabled = activeFilter === "all";

  const selectedClosedCount = selectedClosed.size;
  const selectedClosedQty = closedPalletsFiltered
    .filter((p) => selectedClosed.has(p.id))
    .reduce((s, p) => s + (quantities[p.id] || 0), 0);

  const selectedReadyCount = selectedReady.size;
  const selectedReadyQty = readyPalletsFiltered
    .filter((p) => selectedReady.has(p.id))
    .reduce((s, p) => s + (quantities[p.id] || 0), 0);

  function toggleSelectClosed(id) {
    if (selectionDisabled) return;
    setSelectedClosed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllClosed() {
    if (selectionDisabled) return;
    setSelectedClosed(new Set(closedPalletsFiltered.map((p) => p.id)));
  }

  function clearSelectionClosed() {
    setSelectedClosed(new Set());
  }

  function toggleSelectReady(id) {
    if (selectionDisabled) return;
    setSelectedReady((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllReady() {
    if (selectionDisabled) return;
    setSelectedReady(new Set(readyPalletsFiltered.map((p) => p.id)));
  }

  function clearSelectionReady() {
    setSelectedReady(new Set());
  }

  function palletLabel(p) {
    return p.number ? `${p.number} paletė` : p.code;
  }

  // Kai "ship" teisės nėra, pažymėjimas neprieinamas — eksportuojamos visos
  // šiuo metu matomos (filtruotos) paletės, ne pažymėtos.
  async function handleDownloadSelected() {
    if (canShip && selectedReadyCount === 0) return;
    if (!canShip && readyPalletsFiltered.length === 0) return;
    setDownloading(true);
    const selectedPallets = canShip
      ? readyPalletsFiltered.filter((p) => selectedReady.has(p.id))
      : readyPalletsFiltered;
    const suffix = activeFilter !== "all" ? `-${activeFilter}` : "";
    const { exportPalletsToExcel } = await import("../lib/exportExcel");
    const result = await exportPalletsToExcel(
      selectedPallets,
      `Paletes-${new Date().toISOString().slice(0, 10)}${suffix}.xlsx`
    );
    if (!result.ok) setNotice(result.message);
    setDownloading(false);
  }

  // Uždarytą (closed) paletę pažymi kaip paruoštą išvežimui (ready) — tarpinis
  // žingsnis prieš realų priskyrimą siuntai. "packed_at" (uždarymo data)
  // NEKEIČIAMAS — jis jau užpildytas uždarant paletę.
  // Keliama po vieną didėjančia closed numerio tvarka — taip DB trigeris
  // priskiria ready pozicijas nuosekliai (1→6, 2→7, 3→8, o ne atsitiktine tvarka).
  async function handleMarkSelectedReady() {
    if (selectedClosedCount === 0) return;
    setMarkingReady(true);

    const orderedPallets = closedPalletsFiltered
      .filter((p) => selectedClosed.has(p.id))
      .sort((a, b) => (a.number || 0) - (b.number || 0));

    let errorMessage = "";
    for (const p of orderedPallets) {
      const { error } = await supabase.from("pallets").update({ status: "ready" }).eq("id", p.id);
      if (error) { errorMessage = error.message; break; }
    }

    setMarkingReady(false);

    if (errorMessage) {
      setNotice(`Klaida žymint kaip paruoštą: ${errorMessage}`);
      load();
      return;
    }

    setNotice(`${orderedPallets.length} paletė(-ių) pažymėta kaip paruošta išvežimui`);
    setSelectedClosed(new Set());
    load();
  }

  // Generuoja siuntos kodą pagal dabartinę datą, pvz. "SIUNTA-2026-08-06".
  // Jei tą dieną jau yra siuntų su tokiu kodo priešdėliu (kelios "Pažymėti
  // kaip išvežta" partijos per dieną), pridedamas skaitinis priesagas,
  // kad code nekonfliktuotų su ankstesniu tos dienos įrašu.
  async function generateShipmentCode() {
    const dateStr = new Date().toISOString().slice(0, 10);
    const { data } = await supabase
      .from("shipments")
      .select("code")
      .like("code", `SIUNTA-${dateStr}%`);
    const count = (data || []).length;
    return count === 0
      ? `SIUNTA-${dateStr}`
      : `SIUNTA-${dateStr}-${String(count + 1).padStart(2, "0")}`;
  }

  async function handleMarkSelectedSent() {
    if (selectedReadyCount === 0) return;

    const selectedPalletObjs = readyPalletsFiltered.filter((p) => selectedReady.has(p.id));
    const destinationsSelected = new Set(selectedPalletObjs.map((p) => p.destination || UNCLASSIFIED));
    if (destinationsSelected.size !== 1) {
      setNotice("Klaida: pažymėtos paletės turi skirtingas paskirtis — pasirinkite tik vienos paskirties paletes.");
      return;
    }
    const destination = [...destinationsSelected][0];

    if (!confirm(`Pažymėti ${selectedReadyCount} paletę(-ių) kaip išvežtą(-as)?`)) return;
    setMarking(true);

    const code = await generateShipmentCode();
    const { data: shipment, error: shipmentError } = await supabase
      .from("shipments")
      .insert({ code, status: "sent", sent_at: new Date().toISOString(), destination })
      .select("id, code")
      .single();

    if (shipmentError) {
      setMarking(false);
      setNotice(`Klaida kuriant siuntą: ${shipmentError.message}`);
      return;
    }

    const ids = Array.from(selectedReady);
    const { error: updateError } = await supabase
      .from("pallets")
      .update({ shipment_id: shipment.id })
      .in("id", ids);

    setMarking(false);

    if (updateError) {
      setNotice(`Klaida priskiriant paletes siuntai: ${updateError.message}`);
      return;
    }

    setNotice(`${ids.length} paletė(-ių) pažymėta kaip išvežta (${shipment.code})`);
    setSelectedReady(new Set());
    load();
  }

  async function handleDownloadHistory(shipment) {
    setHistoryDownloadingId(shipment.id);
    const shipmentPallets = shipmentPalletsMap[shipment.id] || [];
    const { exportPalletsToExcel } = await import("../lib/exportExcel");
    const result = await exportPalletsToExcel(shipmentPallets, `${shipment.code}.xlsx`);
    if (!result.ok) setNotice(result.message);
    setHistoryDownloadingId(null);
  }

  // Spausdina pažymėtų paletžų etiketes vienu metu (tinkleliu ant kiek reikia
  // A4 lapų) — rikiuojama pagal numerį, kad lape būtų nuosekli tvarka.
  // Kai "ship" teisės nėra, pažymėjimas neprieinamas — spausdinama visos
  // šiuo metu matomos (filtruotos) paletės, ne pažymėtos.
  function handlePrintSelectedClosed() {
    const selected = (canShip ? closedPalletsFiltered.filter((p) => selectedClosed.has(p.id)) : closedPalletsFiltered)
      .sort((a, b) => (a.number || 0) - (b.number || 0));
    printPalletLabels(selected);
  }

  function handlePrintSelectedReady() {
    const selected = (canShip ? readyPalletsFiltered.filter((p) => selectedReady.has(p.id)) : readyPalletsFiltered)
      .sort((a, b) => (a.number || 0) - (b.number || 0));
    printPalletLabels(selected);
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Paletės</h1>
        <p className="mt-1 text-sm text-ink-600/70">
          Uždarytas paletes pažymėkite kaip paruoštas transportui, tada paruoštas — kaip išvežtas.
        </p>
      </div>

      {notice && (
        <div className="flex items-center gap-2 rounded-xl border border-signal-teal/20 bg-signal-teal/5 px-4 py-3 text-sm font-medium text-signal-teal">
          <CheckCircle2 size={16} className="shrink-0" />
          {notice}
        </div>
      )}

      {/* Paskirties filtras */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-600/50">
          Paskirtis
        </span>
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

      {/* a) Laukia paruošimo — uždarytos (closed) paletės */}
      <div className="panel space-y-4 p-4 lg:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink-800">Laukia paruošimo</h2>
          {canShip && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={selectAllClosed}
              disabled={selectionDisabled || closedPalletsFiltered.length === 0}
              className="btn-secondary"
            >
              <CheckSquare size={14} /> Pažymėti visas
            </button>
            <button
              type="button"
              onClick={clearSelectionClosed}
              disabled={selectedClosedCount === 0}
              className="btn-secondary"
            >
              <Square size={14} /> Nuimti pažymėjimą
            </button>
          </div>
          )}
        </div>

        {canShip && selectionDisabled && (
          <p className="text-xs text-ink-600/50">
            Pasirinkite konkrečią paskirtį aukščiau, kad galėtumėte žymėti paletes — negalima maišyti
            skirtingų paskirčių vienoje siuntoje.
          </p>
        )}

        {loading ? (
          <div className="flex justify-center py-6 text-ink-600/50">
            <Loader2 className="animate-spin" size={20} />
          </div>
        ) : closedPalletsFiltered.length === 0 ? (
          <div className="flex items-center gap-3 py-4 text-sm text-ink-600/60">
            <Clock size={16} className="shrink-0 text-ink-600/30" />
            Nėra uždarytų palečių, laukiančių paruošimo.
          </div>
        ) : (
          <>
            <div className="overflow-hidden rounded-xl border border-ink-700/10">
              <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-ink-900/5 bg-ink-900/[0.02] text-xs uppercase tracking-wide text-ink-600/60">
                  <tr>
                    {canShip && <th className="w-10 px-4 py-3"></th>}
                    <th className="px-4 py-3 font-semibold">Paletė</th>
                    <th className="px-4 py-3 font-semibold">Gamintojas</th>
                    <th className="px-4 py-3 font-semibold">Tipas</th>
                    <th className="px-4 py-3 font-semibold">Uždarymo data</th>
                    <th className="px-4 py-3 font-semibold">Vnt.</th>
                    <th className="px-4 py-3 font-semibold"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-900/5">
                  {closedPalletsFiltered.map((p) => {
                    const { manufacturer, itemType } = splitDestination(p.destination);
                    return (
                    <tr
                      key={p.id}
                      className={selectedClosed.has(p.id) ? "bg-signal-orange/5" : "hover:bg-ink-900/[0.015]"}
                    >
                      {canShip && (
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedClosed.has(p.id)}
                          onChange={() => toggleSelectClosed(p.id)}
                          disabled={selectionDisabled}
                          className="h-4 w-4 rounded border-ink-700/30 text-signal-orange focus:ring-signal-orange/30"
                        />
                      </td>
                      )}
                      <td className="px-4 py-3 font-bold text-ink-900">
                        {palletLabel(p)}
                      </td>
                      <td className="px-4 py-3 text-ink-900">{manufacturer}</td>
                      <td className="px-4 py-3 text-ink-600/80">{itemType}</td>
                      <td className="px-4 py-3 text-ink-600/70">{formatDate(p.packed_at)}</td>
                      <td className="px-4 py-3 font-mono text-ink-800">{quantities[p.id] || 0}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-3">
                          <button
                            type="button"
                            onClick={() => printPalletLabel(p)}
                            className="inline-flex items-center gap-1 text-xs font-medium text-ink-600/70 hover:text-ink-900"
                            aria-label="Spausdinti etiketę"
                          >
                            <Printer size={13} /> Etiketė
                          </button>
                          <Link
                            to={`/paletes/${p.id}`}
                            className="inline-flex items-center gap-1 text-xs font-medium text-signal-orange hover:underline"
                          >
                            Peržiūrėti <ChevronRight size={13} />
                          </Link>
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-900/5 pt-4">
              {canShip && (
              <p className="text-sm text-ink-600/70">
                Pažymėta: <strong className="text-ink-900">{selectedClosedCount}</strong> paletė(-ių),{" "}
                <strong className="text-ink-900">{selectedClosedQty}</strong> vnt.
              </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handlePrintSelectedClosed}
                  disabled={canShip ? selectedClosedCount === 0 : closedPalletsFiltered.length === 0}
                  className="btn-secondary"
                >
                  <Printer size={15} />
                  Spausdinti etiketes
                </button>
                {canShip && (
                <button
                  type="button"
                  onClick={handleMarkSelectedReady}
                  disabled={selectedClosedCount === 0 || markingReady}
                  className="btn-primary"
                >
                  {markingReady
                    ? <Loader2 size={15} className="animate-spin" />
                    : <PackageCheck size={15} />}
                  Pažymėti kaip paruoštą išvežimui
                </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* b) Paruošta išvežimui — ready paletės, checkbox pasirinkimas */}
      <div className="panel space-y-4 p-4 lg:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink-800">Paruošta išvežimui</h2>
          {canShip && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={selectAllReady}
              disabled={selectionDisabled || readyPalletsFiltered.length === 0}
              className="btn-secondary"
            >
              <CheckSquare size={14} /> Pažymėti visas
            </button>
            <button
              type="button"
              onClick={clearSelectionReady}
              disabled={selectedReadyCount === 0}
              className="btn-secondary"
            >
              <Square size={14} /> Nuimti pažymėjimą
            </button>
          </div>
          )}
        </div>

        {canShip && selectionDisabled && (
          <p className="text-xs text-ink-600/50">
            Pasirinkite konkrečią paskirtį aukščiau, kad galėtumėte žymėti paletes — negalima maišyti
            skirtingų paskirčių vienoje siuntoje.
          </p>
        )}

        {loading ? (
          <div className="flex justify-center py-6 text-ink-600/50">
            <Loader2 className="animate-spin" size={20} />
          </div>
        ) : readyPalletsFiltered.length === 0 ? (
          <div className="flex items-center gap-3 py-4 text-sm text-ink-600/60">
            <Clock size={16} className="shrink-0 text-ink-600/30" />
            Nėra palečių, paruoštų išvežimui.
          </div>
        ) : (
          <>
            <div className="overflow-hidden rounded-xl border border-ink-700/10">
              <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-ink-900/5 bg-ink-900/[0.02] text-xs uppercase tracking-wide text-ink-600/60">
                  <tr>
                    {canShip && <th className="w-10 px-4 py-3"></th>}
                    <th className="px-4 py-3 font-semibold">Paletė</th>
                    <th className="px-4 py-3 font-semibold">Uždarymo data</th>
                    <th className="px-4 py-3 font-semibold">Vnt.</th>
                    <th className="px-4 py-3 font-semibold"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-900/5">
                  {readyPalletsFiltered.map((p) => (
                    <tr
                      key={p.id}
                      className={selectedReady.has(p.id) ? "bg-signal-orange/5" : "hover:bg-ink-900/[0.015]"}
                    >
                      {canShip && (
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedReady.has(p.id)}
                          onChange={() => toggleSelectReady(p.id)}
                          disabled={selectionDisabled}
                          className="h-4 w-4 rounded border-ink-700/30 text-signal-orange focus:ring-signal-orange/30"
                        />
                      </td>
                      )}
                      <td className="px-4 py-3 font-semibold text-ink-900">
                        {palletLabel(p)}
                        <DestinationBadge destination={p.destination} />
                      </td>
                      <td className="px-4 py-3 text-ink-600/70">{formatDate(p.packed_at)}</td>
                      <td className="px-4 py-3 font-mono text-ink-800">{quantities[p.id] || 0}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-3">
                          <button
                            type="button"
                            onClick={() => printPalletLabel(p)}
                            className="inline-flex items-center gap-1 text-xs font-medium text-ink-600/70 hover:text-ink-900"
                            aria-label="Spausdinti etiketę"
                          >
                            <Printer size={13} /> Etiketė
                          </button>
                          <Link
                            to={`/paletes/${p.id}`}
                            className="inline-flex items-center gap-1 text-xs font-medium text-signal-orange hover:underline"
                          >
                            Peržiūrėti <ChevronRight size={13} />
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-900/5 pt-4">
              {canShip && (
              <p className="text-sm text-ink-600/70">
                Pažymėta: <strong className="text-ink-900">{selectedReadyCount}</strong> paletė(-ių),{" "}
                <strong className="text-ink-900">{selectedReadyQty}</strong> vnt.
              </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handlePrintSelectedReady}
                  disabled={canShip ? selectedReadyCount === 0 : readyPalletsFiltered.length === 0}
                  className="btn-secondary"
                >
                  <Printer size={15} />
                  Spausdinti etiketes
                </button>
                <button
                  type="button"
                  onClick={handleDownloadSelected}
                  disabled={canShip ? selectedReadyCount === 0 || downloading : downloading || readyPalletsFiltered.length === 0}
                  className="btn-secondary"
                >
                  {downloading
                    ? <Loader2 size={15} className="animate-spin" />
                    : <FileSpreadsheet size={15} />}
                  Atsisiųsti Excel sąrašą
                </button>
                {canShip && (
                <button
                  type="button"
                  onClick={handleMarkSelectedSent}
                  disabled={selectedReadyCount === 0 || marking}
                  className="btn-primary"
                >
                  {marking
                    ? <Loader2 size={15} className="animate-spin" />
                    : <Send size={15} />}
                  Pažymėti kaip išvežta
                </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* c) Jau išvežtos siuntos — istorija */}
      <div className="panel space-y-3 p-4 lg:p-5">
        <h2 className="text-sm font-semibold text-ink-800">Jau išvežtos siuntos</h2>
        {!loading && shipmentsFiltered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <Boxes className="text-ink-600/30" size={24} />
            <p className="text-sm text-ink-600/60">Dar nėra išvežtų siuntų.</p>
          </div>
        ) : (
          <>
            <div className="divide-y divide-ink-900/5">
              {visibleShipments.map((s) => {
                const shipmentPallets = shipmentPalletsMap[s.id] || [];
                const qty = shipmentPallets.reduce((sum, p) => sum + (quantities[p.id] || 0), 0);
                return (
                  <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div>
                      <p className="font-mono text-sm font-semibold text-ink-900">
                        {s.code}
                        <DestinationBadge destination={s.destination} />
                      </p>
                      <p className="text-xs text-ink-600/60">
                        Išvežta {formatDate(s.sent_at)} &middot; {shipmentPallets.length} paletė(-ių) &middot; {qty} vnt.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={`/siuntos/${s.id}`} className="btn-secondary">
                        <Eye size={14} />
                        Peržiūrėti
                      </Link>
                      <button
                        type="button"
                        onClick={() => handleDownloadHistory(s)}
                        disabled={historyDownloadingId === s.id || shipmentPallets.length === 0}
                        className="btn-secondary"
                      >
                        {historyDownloadingId === s.id
                          ? <Loader2 size={14} className="animate-spin" />
                          : <FileSpreadsheet size={14} />}
                        Atsisiųsti Excel
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {shipmentsFiltered.length > 5 && (
              <div className="flex gap-2">
                {shipmentsFiltered.length > visibleShipments.length && (
                  <button
                    type="button"
                    onClick={() => setShipmentHistoryLimit((n) => n + 5)}
                    className="btn-secondary flex-1 justify-center"
                  >
                    Rodyti daugiau ({shipmentsFiltered.length - visibleShipments.length} liko)
                  </button>
                )}
                {shipmentHistoryLimit > 5 && (
                  <button
                    type="button"
                    onClick={() => setShipmentHistoryLimit(5)}
                    className="btn-secondary flex-1 justify-center"
                  >
                    Rodyti mažiau
                  </button>
                )}
                <Link to="/siuntos" className="btn-secondary flex-1 justify-center">
                  Rodyti visas
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
