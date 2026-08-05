import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2, X, Plus } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import StatusBadge from "../components/StatusBadge";
import { PALLET_STATUSES, ITEM_STATUSES } from "../lib/constants";

export default function PalletDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [pallet, setPallet] = useState(null);
  const [items, setItems] = useState([]);
  const [available, setAvailable] = useState([]);
  const [addIan, setAddIan] = useState("");
  const [loading, setLoading] = useState(true);
  const [addError, setAddError] = useState("");

  useEffect(() => {
    load();

    const channel = supabase
      .channel(`pallet-${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "items" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "pallets" }, load)
      .subscribe();

    return () => supabase.removeChannel(channel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function load() {
    setLoading(true);
    const { data: p } = await supabase.from("pallets").select("*").eq("id", id).single();
    const { data: its } = await supabase
      .from("items")
      .select("id, ian, name, status")
      .eq("pallet_id", id)
      .order("created_at", { ascending: false });
    setPallet(p);
    setItems(its || []);
    setLoading(false);
  }

  async function handleStatusChange(status) {
    await supabase.from("pallets").update({ status }).eq("id", id);
  }

  async function handleAddByIan(e) {
    e.preventDefault();
    setAddError("");
    if (!addIan.trim()) return;

    const { data: found, error } = await supabase
      .from("items")
      .select("id, pallet_id")
      .eq("ian", addIan.trim())
      .maybeSingle();

    if (error || !found) {
      setAddError("Prekė su tokiu IAN kodu nerasta.");
      return;
    }
    if (found.pallet_id) {
      setAddError("Ši prekė jau priskirta kitai paletei.");
      return;
    }

    await supabase
      .from("items")
      .update({ pallet_id: id, status: "packed" })
      .eq("id", found.id);
    setAddIan("");
  }

  async function handleRemove(itemId) {
    await supabase.from("items").update({ pallet_id: null, status: "checked" }).eq("id", itemId);
  }

  if (loading || !pallet) {
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
          <h1 className="font-mono text-xl font-bold text-ink-900 lg:text-2xl">{pallet.code}</h1>
          <p className="mt-1 text-sm text-ink-600/70">{items.length} prekės(-ių) paletėje</p>
        </div>
        <select
          value={pallet.status}
          onChange={(e) => handleStatusChange(e.target.value)}
          className="input-field w-48"
        >
          {PALLET_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <form onSubmit={handleAddByIan} className="panel flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
        <input
          value={addIan}
          onChange={(e) => setAddIan(e.target.value)}
          placeholder="Įveskite / nuskenuokite IAN kodą, kad pridėtumėte prie paletės"
          className="input-field flex-1 font-mono"
        />
        <button type="submit" className="btn-primary">
          <Plus size={16} /> Pridėti
        </button>
      </form>
      {addError && <p className="text-sm font-medium text-signal-red">{addError}</p>}

      <div className="panel divide-y divide-ink-900/5">
        {items.length === 0 ? (
          <p className="p-6 text-center text-sm text-ink-600/50">Prekių dar nepridėta.</p>
        ) : (
          items.map((item) => (
            <div key={item.id} className="flex items-center justify-between p-4">
              <div>
                <p className="font-mono text-sm font-medium text-ink-900">{item.ian}</p>
                {item.name && <p className="text-xs text-ink-600/60">{item.name}</p>}
              </div>
              <div className="flex items-center gap-3">
                <StatusBadge list={ITEM_STATUSES} value={item.status} />
                <button
                  onClick={() => handleRemove(item.id)}
                  className="rounded-lg p-1.5 text-ink-600/50 hover:bg-signal-red/10 hover:text-signal-red"
                  aria-label="Pašalinti iš paletės"
                >
                  <X size={15} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
