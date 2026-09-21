import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Boxes, PackageX, AlertTriangle, PackageMinus, Coins, Wrench, HelpCircle, Loader2, ShieldAlert, ShieldCheck, Cpu, MapPin,
  AlertCircle
} from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../lib/AuthProvider";
import { PERIOD_OPTIONS, periodStart } from "../lib/period";
import { useLiveQuery } from "../lib/useLiveQuery";
import { DEVICE_REASON_KEYS, PART_REASON_KEYS, normalizeWriteoffStats, statsErrorMessage } from "../lib/stats";
import ReorderExportButton from "../components/ReorderExportButton";

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

// Klaidos juosta. "stale" — jau turime senesnių duomenų, kurie lieka rodomi po
// juosta; be jų (pirmas užkrovimas nepavyko) rodoma tik juosta.
function StatsError({ error, onRetry, stale = false }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-signal-red/20 bg-signal-red/5 p-3.5 text-sm text-signal-red">
      <AlertCircle size={16} className="mt-0.5 shrink-0" />
      <span className="flex-1">
        {stale ? "Nepavyko atnaujinti statistikos — rodomi ankstesni duomenys." : "Nepavyko įkelti statistikos."}{" "}
        <span className="opacity-80">{statsErrorMessage(error)}</span>
      </span>
      <button type="button" onClick={onRetry} className="shrink-0 font-semibold underline decoration-dotted">
        Bandyti dar kartą
      </button>
    </div>
  );
}

// Bendras kraunimo/klaidų apvalkalas moduliams: spinner'is TIK pirmą kartą;
// vėliau (laikotarpio keitimas, realtime) senas turinys lieka ir tik
// pritemsta, todėl nemirga ir slinkimas nešoka.
function PanelShell({ query, children }) {
  const { data, error, loading, refreshing, reload } = query;

  if (loading) {
    return (
      <div className="flex justify-center py-10 text-ink-600/50">
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  }
  if (!data) return <StatsError error={error} onRetry={reload} />;

  return (
    <div className="space-y-5" aria-busy={refreshing}>
      {error && <StatsError error={error} onRetry={reload} stale />}
      <div className={`space-y-5 transition-opacity ${refreshing ? "opacity-60" : ""}`}>{children(data)}</div>
    </div>
  );
}

// Bendras nurašymų statistikos blokas (kiekis pagal priežastį, pajamos,
// TOP 5) — naudojamas ir priedams, ir prietaisams, nes struktūra (reason_type:
// parduota/remontui/kita) abiejuose moduliuose ta pati. "showWarranty"
// prideda papildomą plytelę 'garantija' priežasčiai — ji egzistuoja TIK
// device_writeoffs (ne parts_writeoffs), tad rodoma tik prietaisų skydelyje.
// "listPath" — /priedai/nurasymai arba /prietaisai/nurasymai, naudojamas
// priežasties plytelėms (su ?priezastis= filtru). "itemsPath" — /priedai
// arba /prietaisai, naudojamas TOP 5 įrašams (su ?q= paieška).
// Plytelių nuorodos perduoda ir pasirinktą laikotarpį (?laikotarpis=), kad
// atidaryta lentelė rodytų tuos pačius nurašymus, kuriuos suskaičiavo plytelė.
function WriteoffStatsSection({ period, stats, topLabel, showWarranty = false, listPath, itemsPath }) {
  const maxTopQty = Math.max(1, ...stats.topItems.map((p) => p.qty));
  const listLink = (reason) => {
    const params = new URLSearchParams();
    if (reason) params.set("priezastis", reason);
    if (period !== "all") params.set("laikotarpis", period);
    const qs = params.toString();
    return qs ? `${listPath}?${qs}` : listPath;
  };
  return (
    <>
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-600/50">
          Nurašymai — {PERIOD_OPTIONS.find((o) => o.value === period)?.label.toLowerCase()}
        </p>
        <div className={`grid grid-cols-2 gap-3 ${showWarranty ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
          <StatTile icon={PackageMinus} label="Iš viso nurašyta" value={`${stats.totalQty} vnt.`} accent="bg-ink-700" to={listLink()} />
          <StatTile icon={Coins} label="Parduota" value={`${stats.revenue.toFixed(2)} €`} accent="bg-signal-teal" to={listLink("parduota")} />
          <StatTile icon={Wrench} label="Panaudota remontui" value={`${stats.byReason.remontui.qty} vnt.`} accent="bg-signal-blue" to={listLink("remontui")} />
          {showWarranty && (
            <StatTile
              icon={ShieldCheck}
              label="Garantiniai pakeitimai"
              value={`${stats.byReason.garantija?.qty ?? 0} vnt.`}
              accent="bg-ink-800"
              to={listLink("garantija")}
            />
          )}
          <StatTile icon={HelpCircle} label="Kita" value={`${stats.byReason.kita.qty} vnt.`} accent="bg-ink-600" to={listLink("kita")} />
        </div>
      </div>

      <div className="panel p-4">
        <p className="mb-3 text-sm font-semibold text-ink-900">{topLabel}</p>
        {stats.topItems.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-600/50">Nurašymų per pasirinktą laikotarpį nebuvo.</p>
        ) : (
          <ul className="space-y-3">
            {stats.topItems.map((p) => {
              const bar = (
                <>
                  <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate text-ink-800" title={p.sub ? `${p.label} — ${p.sub}` : p.label}>
                      {p.label}
                      {p.sub && <span className="ml-2 text-xs text-ink-600/50">{p.sub}</span>}
                    </span>
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
              // Paieška pagal kodą (priedų kodas / prietaiso IAN), ne pagal
              // pavadinimą — kodas tikslesnis, kai skirtingų modelių pavadinimai sutampa.
              return (
                <li key={`${p.code}|${p.label}`}>
                  <Link
                    to={`${itemsPath}?q=${encodeURIComponent(p.code || p.label)}`}
                    className="-m-1 block rounded-lg p-1 transition-colors hover:bg-ink-900/[0.03]"
                  >
                    {bar}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

// Abu skydeliai skaito paruoštus agregatus iš DB funkcijų (žr.
// supabase/migrate_add_stats_functions.sql) — jokio eilučių tempimo į
// naršyklę, todėl sumos tikslios ir kai įrašų daugiau nei 1000.
function PartsStatsPanel({ period }) {
  const query = useLiveQuery(
    async () => {
      const { data, error } = await supabase.rpc("parts_stats", { p_from: periodStart(period) });
      if (error) throw error;
      return data;
    },
    { deps: [period], tables: ["parts", "parts_writeoffs"], channel: "parts-stats-realtime" }
  );

  return (
    <PanelShell query={query}>
      {(data) => {
        const o = data.overview;
        const stats = normalizeWriteoffStats(data, PART_REASON_KEYS, (t) => t.model || "");
        return (
          <>
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-600/50">Sandėlio būklė dabar</p>
                <ReorderExportButton kind="parts" count={Number(o.low_count) + Number(o.out_count)} />
              </div>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatTile icon={Boxes} label="Priedų įrašų" value={Number(o.total_parts)} accent="bg-ink-700" />
                <StatTile icon={Boxes} label="Vienetų iš viso" value={Number(o.total_units)} accent="bg-signal-blue" />
                <StatTile icon={AlertTriangle} label="Mažo likučio" value={Number(o.low_count)} accent="bg-signal-amber" to="/priedai?likutis=low" />
                <StatTile icon={PackageX} label="Pasibaigę" value={Number(o.out_count)} accent="bg-signal-red" to="/priedai?likutis=out" />
              </div>
            </div>

            <WriteoffStatsSection
              period={period}
              stats={stats}
              topLabel="TOP 5 dažniausiai nurašomų priedų"
              listPath="/priedai/nurasymai"
              itemsPath="/priedai"
            />
          </>
        );
      }}
    </PanelShell>
  );
}

function DeviceStatsPanel({ period }) {
  const query = useLiveQuery(
    async () => {
      const { data, error } = await supabase.rpc("device_stats", { p_from: periodStart(period) });
      if (error) throw error;
      return data;
    },
    { deps: [period], tables: ["devices", "device_stock", "device_writeoffs"], channel: "device-stats-realtime" }
  );

  return (
    <PanelShell query={query}>
      {(data) => {
        const o = data.overview;
        // Prietaisams "sub" — IAN (modelio lauko prietaisai neturi)
        const stats = normalizeWriteoffStats(data, DEVICE_REASON_KEYS, (t) => t.code || "");
        return (
          <>
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-600/50">Sandėlio būklė dabar</p>
                <ReorderExportButton kind="devices" count={Number(o.low_count) + Number(o.out_count)} />
              </div>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                <StatTile icon={Cpu} label="Prietaisų modelių" value={Number(o.total_devices)} accent="bg-ink-700" />
                <StatTile icon={Boxes} label="Vienetų iš viso" value={Number(o.total_units)} accent="bg-signal-blue" />
                <StatTile icon={AlertTriangle} label="Mažo likučio" value={Number(o.low_count)} accent="bg-signal-amber" to="/prietaisai?likutis=low" />
                <StatTile icon={PackageX} label="Be likučio" value={Number(o.out_count)} accent="bg-signal-red" to="/prietaisai?likutis=out" />
                <StatTile icon={MapPin} label="Lokacijų iš viso" value={Number(o.location_count)} accent="bg-signal-teal" />
              </div>
            </div>

            <WriteoffStatsSection
              period={period}
              stats={stats}
              topLabel="TOP 5 dažniausiai nurašomų prietaisų"
              listPath="/prietaisai/nurasymai"
              itemsPath="/prietaisai"
              showWarranty
            />
          </>
        );
      }}
    </PanelShell>
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
