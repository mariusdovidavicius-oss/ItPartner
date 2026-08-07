import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2, X, Save, CheckCircle2 } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import StatusBadge from "../components/StatusBadge";
import { PALLET_STATUSES, ITEM_STATUSES } from "../lib/constants";

export default function PalletDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [pallet, setPallet] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notesDraft, setNotesDraft] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesSaved, setNotesSaved] = useState(false);

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
      .select("id, ian, name, status, quantity")
      .eq("pallet_id", id)
      .order("updated_at", { ascending: false });
    setPallet(p);
    setNotesDraft(p?.notes || "");
    setItems(its || []);
    setLoading(false);
  }

  async function handleSaveNotes() {
    setSavingNotes(true);
    setNotesSaved(false);
    await supabase.from("pallets").update({ notes: notesDraft.trim() || null }).eq("id", id);
    setSavingNotes(false);
    setNotesSaved(true);
    setTimeout(() => setNotesSaved(false), 3000);
  }

  async function handleStatusChange(status) {
    await supabase.from("pallets").update({ status }).eq("id", id);
    if (status === "closed") {
      const { data: updated } = await supabase
        .from("pallets")
        .select("number")
        .eq("id", id)
        .single();
      const palletLbl = updated?.number ? `${updated.number} paletė` : "Paletė";
      navigate("/paletes", {
        state: { closedMessage: `${palletLbl} uždaryta ir laukia paruošimo` }
      });
    }
  }

  async function handleRemove(itemId) {
    await supabase.from("items").update({ pallet_id: null, status: "registered" }).eq("id", itemId);
  }

  if (loading || !pallet) {
    return (
      <div className="flex justify-center py-10 text-ink-600/50">
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  }

  const palletLabel = pallet.number ? `${pallet.number} paletė` : pallet.code;
  const totalQty = items.reduce((s, i) => s + (i.quantity || 1), 0);

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
          <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">{palletLabel}</h1>
          <p className="mt-1 text-sm text-ink-600/70">
            {totalQty} vnt. ({items.length} modelių) paletėje
          </p>
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

      <div className="panel space-y-2 p-4 lg:p-5">
        <label className="block text-xs font-semibold text-ink-600/70">Pastaba</label>
        <textarea
          value={notesDraft}
          onChange={(e) => { setNotesDraft(e.target.value); setNotesSaved(false); }}
          rows={3}
          placeholder="Pastaba apie šią paletę (nebūtina)"
          className="input-field resize-none"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSaveNotes}
            disabled={savingNotes || notesDraft === (pallet.notes || "")}
            className="btn-secondary"
          >
            {savingNotes ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Išsaugoti pastabą
          </button>
          {notesSaved && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-signal-teal">
              <CheckCircle2 size={13} /> Išsaugota
            </span>
          )}
        </div>
      </div>

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
                <span className="text-xs font-medium text-ink-600/50">{item.quantity || 1} vnt.</span>
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
