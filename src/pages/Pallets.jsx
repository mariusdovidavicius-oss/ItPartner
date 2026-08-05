import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Loader2, ChevronRight, Boxes } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import StatusBadge from "../components/StatusBadge";
import { PALLET_STATUSES } from "../lib/constants";

export default function Pallets() {
  const [pallets, setPallets] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newCode, setNewCode] = useState("");

  useEffect(() => {
    load();

    const channel = supabase
      .channel("pallets-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "pallets" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "items" }, load)
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, []);

  async function load() {
    setLoading(true);
    const { data: palletData } = await supabase
      .from("pallets")
      .select("id, code, status, notes, created_at")
      .order("created_at", { ascending: false });

    const { data: itemData } = await supabase.from("items").select("pallet_id");

    const tally = {};
    (itemData || []).forEach((i) => {
      if (i.pallet_id) tally[i.pallet_id] = (tally[i.pallet_id] || 0) + 1;
    });

    setPallets(palletData || []);
    setCounts(tally);
    setLoading(false);
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!newCode.trim()) return;
    setCreating(true);
    const { error } = await supabase
      .from("pallets")
      .insert({ code: newCode.trim(), status: "open" });
    setCreating(false);
    if (!error) setNewCode("");
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Paletės / siuntos</h1>
        <p className="mt-1 text-sm text-ink-600/70">Formuokite paletes ir valdykite jų būsenas.</p>
      </div>

      <form onSubmit={handleCreate} className="panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <input
          value={newCode}
          onChange={(e) => setNewCode(e.target.value)}
          placeholder="Naujos paletės kodas, pvz. PAL-2026-001"
          className="input-field flex-1 font-mono"
        />
        <button type="submit" disabled={creating || !newCode.trim()} className="btn-primary">
          {creating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
          Sukurti paletę
        </button>
      </form>

      {loading ? (
        <div className="flex justify-center py-10 text-ink-600/50">
          <Loader2 className="animate-spin" size={20} />
        </div>
      ) : pallets.length === 0 ? (
        <div className="panel flex flex-col items-center gap-2 py-12 text-center">
          <Boxes className="text-ink-600/30" size={28} />
          <p className="text-sm text-ink-600/60">Dar nesukurta nė viena paletė.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {pallets.map((p) => (
            <Link
              key={p.id}
              to={`/paletes/${p.id}`}
              className="panel flex items-center justify-between p-4 transition hover:border-signal-orange/30"
            >
              <div>
                <p className="font-mono text-sm font-semibold text-ink-900">{p.code}</p>
                <p className="mt-1 text-xs text-ink-600/60">{counts[p.id] || 0} prekės(-ių)</p>
                <div className="mt-2">
                  <StatusBadge list={PALLET_STATUSES} value={p.status} />
                </div>
              </div>
              <ChevronRight size={18} className="text-ink-600/30" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
