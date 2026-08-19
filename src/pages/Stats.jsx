import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Boxes, PackageX, AlertTriangle, PackageMinus, Coins, Wrench, HelpCircle, Loader2, ShieldAlert, ShieldCheck, Cpu, MapPin
} from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../lib/AuthProvider";

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

// "to" nebūtinas — kai jo nėra (pvz. bendros sumos, kurių filtruoti
// negalima, tokios kaip "Vienetų iš viso"), plytelė lieka paprasta
// informacinė kortelė, ne nuoroda.
function StatTile({ icon: Icon, label, value, accent, to }) {
  const content = (
    <>
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${accent}`}>
        <Icon size={18} className="text-white" strokeWidth={2.2} />
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-ink-600/60">{label}</p>
        <p className="text-xl font-bold text-ink-900">{value}</p>
      </div>
    </>
  );
  if (to) {
    return (
      <Link to={to} className="panel flex items-center gap-3 p-4 transition-colors hover:bg-ink-900/[0.02]">
        {content}
      </Link>
    );
  }
  return <div className="panel flex items-center gap-3 p-4">{content}</div>;
}

// Bendras nurašymų statistikos blokas (kiekis pagal priežastį, pajamos,
// TOP 5) — naudojamas ir priedams, ir prietaisams, nes struktūra (reason_type:
// parduota/remontui/kita) abiejuose moduliuose ta pati. "showWarranty"
// prideda papildomą plytelę 'garantija' priežasčiai — ji egzistuoja TIK
// device_writeoffs (ne parts_writeoffs), tad rodoma tik prietaisų skydelyje.
// "listPath" — /priedai/nurasymai arba /prietaisai/nurasymai, naudojamas
// priežasties plytelėms (su ?priezastis= filtru). "itemsPath" — /priedai
// arba /prietaisai, naudojamas TOP 5 įrašams (su ?q= paieška).
function WriteoffStatsSection({ period, stats, topLabel, showWarranty = false, listPath, itemsPath }) {
  const maxTopQty = Math.max(1, ...stats.topItems.map((p) => p.qty));
  return (
    <>
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-600/50">
          Nurašymai — {PERIOD_OPTIONS.find((o) => o.value === period)?.label.toLowerCase()}
        </p>
        <div className={`grid grid-cols-2 gap-3 ${showWarranty ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
          <StatTile icon={PackageMinus} label="Iš viso nurašyta" value={`${stats.totalQty} vnt.`} accent="bg-ink-700" to={listPath} />
          <StatTile icon={Coins} label="Parduota" value={`${stats.revenue.toFixed(2)} €`} accent="bg-signal-teal" to={`${listPath}?priezastis=parduota`} />
          <StatTile icon={Wrench} label="Panaudota remontui" value={`${stats.byReason.remontui.qty} vnt.`} accent="bg-signal-blue" to={`${listPath}?priezastis=remontui`} />
          {showWarranty && (
            <StatTile
              icon={ShieldCheck}
              label="Garantiniai pakeitimai"
              value={`${stats.byReason.garantija?.qty ?? 0} vnt.`}
              accent="bg-ink-800"
              to={`${listPath}?priezastis=garantija`}
            />
          )}
          <StatTile icon={HelpCircle} label="Kita" value={`${stats.byReason.kita.qty} vnt.`} accent="bg-ink-600" to={`${listPath}?priezastis=kita`} />
        </div>
      </div>

      <div className="panel p-4">
        <p className="mb-3 text-sm font-semibold text-ink-900">{topLabel}</p>
        {stats.topItems.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-600/50">Nurašymų per pasirinktą laikotarpį nebuvo.</p>
        ) : (
          <ul className="space-y-3">
            {stats.topItems.map((p, i) => {
              const bar = (
                <>
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
                </>
              );
              return (
                <li key={i}>
                  {p.label && p.label !== "—" ? (
                    <Link
                      to={`${itemsPath}?q=${encodeURIComponent(p.label)}`}
                      className="-m-1 block rounded-lg p-1 transition-colors hover:bg-ink-900/[0.03]"
                    >
                      {bar}
                    </Link>
                  ) : (
                    bar
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

function PartsStatsPanel({ period }) {
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState({ totalParts: 0, totalUnits: 0, lowCount: 0, outCount: 0 });
  const [writeoffStats, setWriteoffStats] = useState({
    totalQty: 0,
    revenue: 0,
    byReason: { parduota: emptyReasonBucket(), remontui: emptyReasonBucket(), kita: emptyReasonBucket() },
    topItems: []
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
    const byItem = new Map();
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
      const prev = byItem.get(w.part_id);
      if (prev) prev.qty += qty;
      else byItem.set(w.part_id, { label, qty });
    });

    const topItems = [...byItem.values()].sort((a, b) => b.qty - a.qty).slice(0, 5);
    setWriteoffStats({ totalQty, revenue, byReason, topItems });
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

  if (loading) {
    return (
      <div className="flex justify-center py-10 text-ink-600/50">
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  }

  return (
    <>
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-600/50">Sandėlio būklė dabar</p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile icon={Boxes} label="Priedų įrašų" value={overview.totalParts} accent="bg-ink-700" />
          <StatTile icon={Boxes} label="Vienetų iš viso" value={overview.totalUnits} accent="bg-signal-blue" />
          <StatTile icon={AlertTriangle} label="Mažo likučio" value={overview.lowCount} accent="bg-signal-amber" to="/priedai?likutis=low" />
          <StatTile icon={PackageX} label="Pasibaigę" value={overview.outCount} accent="bg-signal-red" to="/priedai?likutis=out" />
        </div>
      </div>

      <WriteoffStatsSection
        period={period}
        stats={writeoffStats}
        topLabel="TOP 5 dažniausiai nurašomų priedų"
        listPath="/priedai/nurasymai"
        itemsPath="/priedai"
      />
    </>
  );
}

function DeviceStatsPanel({ period }) {
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState({ totalDevices: 0, totalUnits: 0, lowCount: 0, outCount: 0, locationCount: 0 });
  const [writeoffStats, setWriteoffStats] = useState({
    totalQty: 0,
    revenue: 0,
    byReason: {
      parduota: emptyReasonBucket(), remontui: emptyReasonBucket(),
      garantija: emptyReasonBucket(), kita: emptyReasonBucket()
    },
    topItems: []
  });

  async function loadOverview() {
    const [{ count: totalDevices }, { data: totals }, { count: locationCount }] = await Promise.all([
      supabase.from("devices").select("id", { count: "exact", head: true }),
      supabase.from("device_totals").select("total_quantity, stock_level").range(0, 9999),
      supabase.from("device_stock").select("id", { count: "exact", head: true })
    ]);
    const list = totals || [];
    setOverview({
      totalDevices: totalDevices ?? 0,
      totalUnits: list.reduce((sum, r) => sum + (r.total_quantity || 0), 0),
      lowCount: list.filter((r) => r.stock_level === "low").length,
      outCount: list.filter((r) => r.stock_level === "out").length,
      locationCount: locationCount ?? 0
    });
  }

  // Skaičiuojama tik iš AKTYVIŲ (neatšauktų) nurašymų — ta pati logika kaip
  // priedų statistikoje (žr. loadWriteoffStats PartsStatsPanel viduje).
  async function loadWriteoffStats() {
    let query = supabase
      .from("device_writeoffs")
      .select("quantity, reason_type, price, device_id, device_name, device_ian")
      .is("undone_at", null)
      .range(0, 4999);
    const start = periodStart(period);
    if (start) query = query.gte("created_at", start);
    const { data } = await query;
    const rows = data || [];

    const byReason = {
      parduota: emptyReasonBucket(), remontui: emptyReasonBucket(),
      garantija: emptyReasonBucket(), kita: emptyReasonBucket()
    };
    const byItem = new Map();
    let totalQty = 0;
    let revenue = 0;

    rows.forEach((w) => {
      const qty = w.quantity || 0;
      totalQty += qty;
      const bucket = byReason[w.reason_type] || (byReason[w.reason_type] = emptyReasonBucket());
      bucket.count += 1;
      bucket.qty += qty;
      if (w.reason_type === "parduota" && w.price != null) revenue += Number(w.price);

      const label = w.device_name || w.device_ian || "—";
      const prev = byItem.get(w.device_id);
      if (prev) prev.qty += qty;
      else byItem.set(w.device_id, { label, qty });
    });

    const topItems = [...byItem.values()].sort((a, b) => b.qty - a.qty).slice(0, 5);
    setWriteoffStats({ totalQty, revenue, byReason, topItems });
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
      .channel("device-stats-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, () => loadRef.current())
      .on("postgres_changes", { event: "*", schema: "public", table: "device_stock" }, () => loadRef.current())
      .on("postgres_changes", { event: "*", schema: "public", table: "device_writeoffs" }, () => loadRef.current())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-10 text-ink-600/50">
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  }

  return (
    <>
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-600/50">Sandėlio būklė dabar</p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile icon={Cpu} label="Prietaisų modelių" value={overview.totalDevices} accent="bg-ink-700" />
          <StatTile icon={Boxes} label="Vienetų iš viso" value={overview.totalUnits} accent="bg-signal-blue" />
          <StatTile icon={AlertTriangle} label="Mažo likučio" value={overview.lowCount} accent="bg-signal-amber" to="/prietaisai?likutis=low" />
          <StatTile icon={PackageX} label="Be likučio" value={overview.outCount} accent="bg-signal-red" to="/prietaisai?likutis=out" />
          <StatTile icon={MapPin} label="Lokacijų iš viso" value={overview.locationCount} accent="bg-signal-teal" />
        </div>
      </div>

      <WriteoffStatsSection
        period={period}
        stats={writeoffStats}
        topLabel="TOP 5 dažniausiai nurašomų prietaisų"
        listPath="/prietaisai/nurasymai"
        itemsPath="/prietaisai"
        showWarranty
      />
    </>
  );
}

const MODULES = [
  { key: "parts", label: "Priedai" },
  { key: "devices", label: "Prietaisai" }
];

export default function Stats() {
  const { hasPermission, hasDevicePermission } = useAuth();
  const canViewParts = hasPermission("delete");
  // Reikia IR "view" (sandėlio būklės plytelės skaito devices/device_totals/
  // device_stock, kurių RLS reikalauja 'view'), IR "delete" (device_writeoffs
  // RLS reikalauja 'delete') — priešingu atveju pusė skydelio tyliai rodytų
  // klaidingus nulius vartotojui, turinčiam tik vieną iš dviejų teisių.
  const canViewDevices = hasDevicePermission("view") && hasDevicePermission("delete");

  const [module, setModule] = useState(canViewParts ? "parts" : "devices");
  const [period, setPeriod] = useState("30d");

  const availableModules = MODULES.filter(
    (m) => (m.key === "parts" && canViewParts) || (m.key === "devices" && canViewDevices)
  );

  if (!canViewParts && !canViewDevices) {
    return (
      <div className="flex flex-col items-center gap-2 py-20 text-center text-ink-600/60">
        <ShieldAlert size={22} className="text-ink-600/30" />
        <p className="text-sm font-medium">Neturite teisės pasiekti šį puslapį.</p>
      </div>
    );
  }

  const activeModule = availableModules.some((m) => m.key === module) ? module : availableModules[0].key;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Statistika</h1>
          <p className="mt-1 text-sm text-ink-600/70">Sandėlio ir nurašymų apžvalga.</p>
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

      {availableModules.length > 1 && (
        <div className="inline-flex rounded-xl border border-ink-700/10 bg-ink-900/[0.02] p-1">
          {availableModules.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setModule(m.key)}
              className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${
                activeModule === m.key
                  ? "bg-white text-ink-900 shadow-sm"
                  : "text-ink-600/60 hover:text-ink-900"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}

      {activeModule === "parts" ? (
        <PartsStatsPanel period={period} />
      ) : (
        <DeviceStatsPanel period={period} />
      )}
    </div>
  );
}
