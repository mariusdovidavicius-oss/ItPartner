import { useEffect, useMemo, useState } from "react";
import { Search, X, Pencil, Trash2, Loader2 } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import StatusBadge from "../components/StatusBadge";
import { ITEM_STATUSES } from "../lib/constants";

export default function ItemsTable() {
  const [items, setItems] = useState([]);
  const [pallets, setPallets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    loadItems();
    loadPallets();

    // Real-time: klausomasi bet kokių pasikeitimų "items" lentelėje
    const channel = supabase
      .channel("items-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "items" }, () => {
        loadItems();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  async function loadItems() {
    setLoading(true);
    const { data } = await supabase
      .from("items")
      .select("id, ian, name, category, status, notes, pallet_id, quantity, created_at")
      .order("created_at", { ascending: false });
    setItems(data || []);
    setLoading(false);
  }

  async function loadPallets() {
    const { data } = await supabase
      .from("pallets")
      .select("id, code, status")
      .order("created_at", { ascending: false });
    setPallets(data || []);
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      const matchesSearch =
        !q ||
        item.ian?.toLowerCase().includes(q) ||
        item.name?.toLowerCase().includes(q) ||
        item.category?.toLowerCase().includes(q);
      const matchesStatus = !statusFilter || item.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [items, search, statusFilter]);

  async function handleDelete(id) {
    if (!confirm("Ar tikrai norite ištrinti šį įrašą?")) return;
    await supabase.from("items").delete().eq("id", id);
  }

  async function handleSave(updated) {
    const { id, ian, name, category, status, notes, pallet_id, quantity } = updated;
    await supabase
      .from("items")
      .update({
        ian, name, category, status, notes,
        pallet_id: pallet_id || null,
        quantity: Math.max(1, Math.round(Number(quantity)) || 1)
      })
      .eq("id", id);
    setEditing(null);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Prekių lentelė</h1>
          <p className="mt-1 text-sm text-ink-600/70">
            Realaus laiko duomenys · iš viso {items.length} įrašų
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-600/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Ieškoti pagal IAN, pavadinimą, kategoriją…"
            className="input-field pl-10"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="input-field sm:w-56"
        >
          <option value="">Visos būsenos</option>
          {ITEM_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-900/5 bg-ink-900/[0.02] text-xs uppercase tracking-wide text-ink-600/60">
              <tr>
                <th className="px-4 py-3 font-semibold">IAN</th>
                <th className="px-4 py-3 font-semibold">Pavadinimas</th>
                <th className="px-4 py-3 font-semibold">Kategorija</th>
                <th className="px-4 py-3 font-semibold">Kiekis</th>
                <th className="px-4 py-3 font-semibold">Būsena</th>
                <th className="px-4 py-3 font-semibold">Paletė</th>
                <th className="px-4 py-3 font-semibold text-right">Veiksmai</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-900/5">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-ink-600/50">
                    <Loader2 className="mx-auto animate-spin" size={20} />
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-ink-600/50">
                    Rezultatų nerasta.
                  </td>
                </tr>
              ) : (
                filtered.map((item) => (
                  <tr key={item.id} className="hover:bg-ink-900/[0.015]">
                    <td className="px-4 py-3 font-mono font-medium text-ink-900">{item.ian}</td>
                    <td className="px-4 py-3 text-ink-800">{item.name || "—"}</td>
                    <td className="px-4 py-3 text-ink-600/70">{item.category || "—"}</td>
                    <td className="px-4 py-3 font-mono text-sm text-ink-800">{item.quantity ?? 1}</td>
                    <td className="px-4 py-3">
                      <StatusBadge list={ITEM_STATUSES} value={item.status} />
                    </td>
                    <td className="px-4 py-3 text-ink-600/70">
                      {pallets.find((p) => p.id === item.pallet_id)?.code || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1.5">
                        <button
                          onClick={() => setEditing(item)}
                          className="rounded-lg p-2 text-ink-600/60 hover:bg-ink-900/5 hover:text-ink-900"
                          aria-label="Redaguoti"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          onClick={() => handleDelete(item.id)}
                          className="rounded-lg p-2 text-ink-600/60 hover:bg-signal-red/10 hover:text-signal-red"
                          aria-label="Trinti"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <EditModal
          item={editing}
          pallets={pallets}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

function EditModal({ item, pallets, onClose, onSave }) {
  const [form, setForm] = useState(item);
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    await onSave(form);
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink-950/50 p-0 sm:items-center sm:p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-lg rounded-t-2xl bg-white p-5 shadow-panel sm:rounded-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">Redaguoti įrašą</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-ink-900/5">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">IAN kodas</label>
            <input
              value={form.ian || ""}
              onChange={(e) => setForm({ ...form, ian: e.target.value })}
              className="input-field font-mono"
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pavadinimas</label>
              <input
                value={form.name || ""}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="input-field"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">Kategorija</label>
              <input
                value={form.category || ""}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className="input-field"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Kiekis</label>
            <input
              type="number"
              min={1}
              value={form.quantity ?? 1}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              className="input-field"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">Būsena</label>
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
                className="input-field"
              >
                {ITEM_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">Paletė</label>
              <select
                value={form.pallet_id || ""}
                onChange={(e) => setForm({ ...form, pallet_id: e.target.value })}
                className="input-field"
              >
                <option value="">Nepriskirta</option>
                {pallets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pastaba</label>
            <textarea
              value={form.notes || ""}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              className="input-field resize-none"
            />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Atšaukti
          </button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving && <Loader2 size={15} className="animate-spin" />}
            Išsaugoti
          </button>
        </div>
      </form>
    </div>
  );
}
