import { useEffect, useRef, useState } from "react";
import { Boxes, PackageX, AlertTriangle, PackageMinus, Coins, Wrench, HelpCircle, Loader2 } from "lucide-react";
import { supabase } from "../lib/supabaseClient";

const PERIOD_OPTIONS = [
  { value: "30d", label: "Paskutinės 30 d." },
  { value: "ytd", label: "Šie metai" },
  { value: "all", label: "Visada" }
];

function periodStart(period) {
  const now = new Date();
  if (period === "30d") {
    const d = new Date(now);
    d.setDate(d.getDate() - 30);
    return d.toISOString();
  }
  if (period === "ytd") return new Date(now.getFullYear(), 0, 1).toISOString();
  return null;
}

function emptyReasonBucket() {
  return { count: 0, qty: 0 };
}

function StatTile({ icon: Icon, label, value, accent }) {
  return (
    <div className="panel flex items-center gap-3 p-4">
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${accent}`}>
        <Icon size={18} className="text-white" strokeWidth={2.2} />
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-ink-600/60">{label}</p>
        <p className="text-xl font-bold text-ink-900">{value}</p>
      </div>
    </div>
  );
}

export default function PartsStats() {
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState("30d");
  const [overview, setOverview] = useState({ totalParts: 0, totalUnits: 0, lowCount: 0, outCount: 0 });
  const [writeoffStats, setWriteoffStats] = useState({
    totalQty: 0,
    revenue: 0,
    byReason: { parduota: emptyReasonBucket(), remontui: emptyReasonBucket(), kita: emptyReasonBucket() },
    topParts: []
  });

  async function loadOverview() {
    const [{ count: totalParts }, { data: rows }] = await Promise.all([
      supabase.from("parts").select("id", { count: "exact", head: true }),
      supabase.from("parts").select("quantity, stock_level").range(0, 9999)
    ]);
    const list = rows || [];
    setOverview({
      totalParts: totalParts ?? 0,
      totalUnits: list.reduce((sum, r) => sum + (r.quantity || 0), 0),
      lowCount: list.filter((r) => r.stock_level === "low").length,
      outCount: list.filter((r) => r.stock_level === "out").length
    });
  }

  // Skaičiuojama tik iš AKTYVIŲ (neatšauktų) nurašymų — atšaukti (undone_at
  // nustatytas) neturi būti įskaičiuoti į sumas/statistiką, nes kiekis jau
  // grąžintas atgal į parts.quantity (žr. undo_writeoff() migracijoje).
  async function loadWriteoffStats() {
    let query = supabase
      .from("parts_writeoffs")
      .select("quantity, reason_type, price, part_id, parts(name, part_code)")
      .is("undone_at", null)
      .range(0, 4999);
    const start = periodStart(period);
    if (start) query = query.gte("created_at", start);
    const { data } = await query;
    const rows = data || [];

    const byReason = { parduota: emptyReasonBucket(), remontui: emptyReasonBucket(), kita: emptyReasonBucket() };
    const byPart = new Map();
    let totalQty = 0;
    let revenue = 0;

    rows.forEach((w) => {
      const qty = w.quantity || 0;
      totalQty += qty;
      const bucket = byReason[w.reason_type] || (byReason[w.reason_type] = emptyReasonBucket());
      bucket.count += 1;
      bucket.qty += qty;
      if (w.reason_type === "parduota" && w.price != null) revenue += Number(w.price);

      const label = w.parts?.name || w.parts?.part_code || "—";
      const prev = byPart.get(w.part_id);
      if (prev) prev.qty += qty;
      else byPart.set(w.part_id, { label, qty });
    });

    const topParts = [...byPart.values()].sort((a, b) => b.qty - a.qty).slice(0, 5);
    setWriteoffStats({ totalQty, revenue, byReason, topParts });
  }

  async function load() {
    setLoading(true);
    await Promise.all([loadOverview(), loadWriteoffStats()]);
    setLoading(false);
  }

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  useEffect(() => {
    const channel = supabase
      .channel("parts-stats-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "parts" }, () => loadRef.current())
      .on("postgres_changes", { event: "*", schema: "public", table: "parts_writeoffs" }, () => loadRef.current())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  const maxTopQty = Math.max(1, ...writeoffStats.topParts.map((p) => p.qty));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Statistika</h1>
          <p className="mt-1 text-sm text-ink-600/70">Priedų sandėlio ir nurašymų apžvalga.</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-ink-600/70">
          Laikotarpis
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="input-field w-auto py-1.5 text-sm"
          >
            {PERIOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>

      {loading ? (
        <div className="flex justify-center py-10 text-ink-600/50">
          <Loader2 className="animate-spin" size={20} />
        </div>
      ) : (
        <>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-600/50">Sandėlio būklė dabar</p>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile icon={Boxes} label="Priedų įrašų" value={overview.totalParts} accent="bg-ink-700" />
              <StatTile icon={Boxes} label="Vienetų iš viso" value={overview.totalUnits} accent="bg-signal-blue" />
              <StatTile icon={AlertTriangle} label="Mažo likučio" value={overview.lowCount} accent="bg-signal-amber" />
              <StatTile icon={PackageX} label="Pasibaigę" value={overview.outCount} accent="bg-signal-red" />
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-600/50">
              Nurašymai — {PERIOD_OPTIONS.find((o) => o.value === period)?.label.toLowerCase()}
            </p>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile icon={PackageMinus} label="Iš viso nurašyta" value={`${writeoffStats.totalQty} vnt.`} accent="bg-ink-700" />
              <StatTile icon={Coins} label="Parduota" value={`${writeoffStats.revenue.toFixed(2)} €`} accent="bg-signal-teal" />
              <StatTile icon={Wrench} label="Panaudota remontui" value={`${writeoffStats.byReason.remontui.qty} vnt.`} accent="bg-signal-blue" />
              <StatTile icon={HelpCircle} label="Kita" value={`${writeoffStats.byReason.kita.qty} vnt.`} accent="bg-ink-600" />
            </div>
          </div>

          <div className="panel p-4">
            <p className="mb-3 text-sm font-semibold text-ink-900">TOP 5 dažniausiai nurašomų priedų</p>
            {writeoffStats.topParts.length === 0 ? (
              <p className="py-4 text-center text-sm text-ink-600/50">Nurašymų per pasirinktą laikotarpį nebuvo.</p>
            ) : (
              <ul className="space-y-3">
                {writeoffStats.topParts.map((p, i) => (
                  <li key={i}>
                    <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-ink-800">{p.label}</span>
                      <span className="shrink-0 font-semibold text-ink-900">{p.qty} vnt.</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-ink-900/5">
                      <div
                        className="h-full rounded-full bg-signal-orange"
                        style={{ width: `${Math.max(4, (p.qty / maxTopQty) * 100)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
