import { useEffect, useState } from "react";
import { Warehouse, Plus, Trash2, Loader2, AlertCircle } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { formatDate } from "../lib/format";

// Sandėlių (fizinių vietų) sąrašo administravimas — vien pavadinimas.
// Kuria/trina TIK adminas (RLS + pati /sandeliai route reikalauja "admin",
// žr. App.jsx). Peržiūra kitiems moduliams (device_stock.warehouse_id)
// lieka vieša — čia tvarkomas tik pats sąrašas.
//
// Trinti galima tik sandėlį, kurio niekas nenaudoja (device_stock/
// device_writeoffs/parts turi "references public.warehouses (id)" be "on delete",
// t.y. RESTRICT) — DB tiesiog atmes bandymą su aiškia klaida, kurią čia
// paverčiame suprantamu pranešimu.
export default function Warehouses() {
  const [warehouses, setWarehouses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [actionError, setActionError] = useState("");

  async function load() {
    setLoading(true);
    const { data } = await supabase.from("warehouses").select("id, name, created_at").order("name");
    setWarehouses(data || []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    const channel = supabase
      .channel("warehouses-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "warehouses" }, load)
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  async function handleCreate(e) {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    setCreating(true);
    setActionError("");
    const { error } = await supabase.from("warehouses").insert({ name: value });
    setCreating(false);
    if (error) {
      // Unikalumas neatsižvelgia į raidžių dydį (warehouses_name_ci_unique),
      // tad parodomas ESAMAS pavadinimas ("Grizzly"), ne įvestas ("grizzly").
      const existing = warehouses.find((w) => w.name.trim().toLowerCase() === value.toLowerCase());
      setActionError(
        error.code === "23505"
          ? `Sandėlis „${existing?.name ?? value}“ jau egzistuoja.`
          : `Nepavyko sukurti: ${error.message}`
      );
      return;
    }
    setName("");
  }

  async function handleDelete(warehouse) {
    if (!confirm(`Ar tikrai norite ištrinti sandėlį „${warehouse.name}“?`)) return;
    setDeletingId(warehouse.id);
    setActionError("");
    const { error } = await supabase.from("warehouses").delete().eq("id", warehouse.id);
    setDeletingId(null);
    if (error) {
      setActionError(
        error.code === "23503"
          ? `Sandėlio „${warehouse.name}“ ištrinti negalima — jame yra prietaisų, priedų arba nurašymų istorijos.`
          : `Nepavyko ištrinti: ${error.message}`
      );
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Sandėliai</h1>
        <p className="mt-1 text-sm text-ink-600/70">
          Fizinių sandėlių sąrašas (bendras prietaisams ir priedams) — matomas visiems, tvarkyti gali tik adminas.
        </p>
      </div>

      {actionError && (
        <div className="flex items-start gap-2 rounded-xl border border-signal-red/20 bg-signal-red/5 p-3.5 text-sm text-signal-red">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span className="flex-1">{actionError}</span>
        </div>
      )}

      <form onSubmit={handleCreate} className="panel flex items-end gap-2 p-4">
        <div className="flex-1">
          <label className="mb-1 block text-xs font-semibold text-ink-600/70">Naujo sandėlio pavadinimas</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="pvz. Pagrindinis sandėlis"
            className="input-field"
          />
        </div>
        <button type="submit" disabled={creating || !name.trim()} className="btn-primary shrink-0">
          {creating ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
          Sukurti
        </button>
      </form>

      <div className="panel overflow-hidden p-0">
        {loading ? (
          <div className="flex justify-center py-10 text-ink-600/50">
            <Loader2 className="animate-spin" size={20} />
          </div>
        ) : warehouses.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Warehouse className="text-ink-600/30" size={24} />
            <p className="text-sm text-ink-600/60">Sandėlių dar nėra — sukurkite pirmą aukščiau.</p>
          </div>
        ) : (
          <ul className="divide-y divide-ink-900/5">
            {warehouses.map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink-900">{w.name}</p>
                  <p className="text-xs text-ink-600/50">Sukurta {formatDate(w.created_at)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(w)}
                  disabled={deletingId === w.id}
                  className="shrink-0 rounded-lg p-1.5 text-ink-600/40 hover:bg-signal-red/10 hover:text-signal-red"
                  aria-label="Ištrinti sandėlį"
                >
                  {deletingId === w.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
