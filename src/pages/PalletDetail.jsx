import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2, X, Save, CheckCircle2, AlertCircle, Pencil, Plus } from "lucide-react";
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

  const [addIan, setAddIan] = useState("");
  const [addingItem, setAddingItem] = useState(false);
  const [addError, setAddError] = useState("");
  const addInputRef = useRef(null);

  const [editingItem, setEditingItem] = useState(null);
  const [removingId, setRemovingId] = useState(null);
  const [removeError, setRemoveError] = useState("");
  const [statusError, setStatusError] = useState("");

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
      .select("id, ian, name, status, quantity, notes")
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
    setStatusError("");
    const { error } = await supabase.from("pallets").update({ status }).eq("id", id);
    if (error) {
      setStatusError(`Klaida keičiant būseną: ${error.message}`);
      return;
    }
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
    setRemovingId(itemId);
    setRemoveError("");
    const { error } = await supabase
      .from("items")
      .update({ pallet_id: null, status: "registered" })
      .eq("id", itemId);
    setRemovingId(null);
    if (error) {
      setRemoveError(`Klaida šalinant: ${error.message}`);
      return;
    }
    // Nepasikliaujame vien realtime prenumerata — iškart perkrauname patys,
    // kad sąrašas atsinaujintų be jokio uždelsimo.
    load();
  }

  // Prekės pridėjimas TIESIAI į šią paletę (nepriklausomai nuo jos būsenos —
  // 'closed'/'ready' paletės anksčiau neturėjo jokio būdo įtraukti naują
  // prekę, tik ScanEntry, kuri visada renkasi/kuria atvirą paletę). Jei toks
  // IAN šioje paletėje jau yra — kiekis padidinamas, ne kuriamas dublikatas.
  async function handleAddItem(e) {
    e.preventDefault();
    const trimmedIan = addIan.trim();
    if (!trimmedIan) return;

    setAddingItem(true);
    setAddError("");

    const { data: existing } = await supabase
      .from("items")
      .select("id, quantity")
      .eq("ian", trimmedIan)
      .eq("pallet_id", id)
      .maybeSingle();

    if (existing) {
      const { error } = await supabase
        .from("items")
        .update({ quantity: existing.quantity + 1 })
        .eq("id", existing.id);
      if (error) {
        setAddError(`Klaida pridedant: ${error.message}`);
        setAddingItem(false);
        return;
      }
    } else {
      const { data: catalogRow } = await supabase
        .from("catalog")
        .select("name")
        .eq("ian", trimmedIan)
        .maybeSingle();

      const { error } = await supabase.from("items").insert({
        ian: trimmedIan,
        name: catalogRow?.name || null,
        status: "packed",
        pallet_id: id,
        quantity: 1
      });
      if (error) {
        setAddError(`Klaida pridedant: ${error.message}`);
        setAddingItem(false);
        return;
      }
    }

    setAddIan("");
    setAddingItem(false);
    addInputRef.current?.focus();
    load();
  }

  async function handleSaveItem(itemId, form) {
    await supabase
      .from("items")
      .update({
        ian: form.ian.trim(),
        name: form.name.trim() || null,
        quantity: Math.max(1, Math.round(Number(form.quantity)) || 1),
        notes: form.notes.trim() || null
      })
      .eq("id", itemId);
    setEditingItem(null);
    load();
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

      {statusError && (
        <p className="flex items-center gap-1.5 text-xs text-signal-red">
          <AlertCircle size={13} /> {statusError}
        </p>
      )}

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

      <form onSubmit={handleAddItem} className="panel space-y-2 p-4 lg:p-5">
        <label className="block text-xs font-semibold text-ink-600/70">Pridėti prekę į šią paletę</label>
        <div className="flex flex-wrap gap-2">
          <input
            ref={addInputRef}
            value={addIan}
            onChange={(e) => { setAddIan(e.target.value); setAddError(""); }}
            placeholder="IAN kodas"
            autoComplete="off"
            className="input-field flex-1 font-mono"
          />
          <button type="submit" disabled={addingItem || !addIan.trim()} className="btn-primary">
            {addingItem ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            Pridėti
          </button>
        </div>
        {addError && (
          <p className="flex items-center gap-1.5 text-xs text-signal-red">
            <AlertCircle size={13} /> {addError}
          </p>
        )}
      </form>

      {removeError && (
        <p className="flex items-center gap-1.5 text-xs text-signal-red">
          <AlertCircle size={13} /> {removeError}
        </p>
      )}

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
                  onClick={() => setEditingItem(item)}
                  className="rounded-lg p-1.5 text-ink-600/60 hover:bg-ink-900/5 hover:text-ink-900"
                  aria-label="Redaguoti"
                >
                  <Pencil size={15} />
                </button>
                <button
                  onClick={() => handleRemove(item.id)}
                  disabled={removingId === item.id}
                  className="rounded-lg p-1.5 text-ink-600/50 hover:bg-signal-red/10 hover:text-signal-red disabled:opacity-40"
                  aria-label="Pašalinti iš paletės"
                >
                  {removingId === item.id
                    ? <Loader2 size={15} className="animate-spin" />
                    : <X size={15} />}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {editingItem && (
        <EditItemModal
          item={editingItem}
          onClose={() => setEditingItem(null)}
          onSave={handleSaveItem}
        />
      )}
    </div>
  );
}

// Prekės redagavimo modalas — ian/name/quantity/notes. Status ir pallet_id
// čia nekeičiami tiesiogiai (statusui yra atskiras StatusBadge/darbo eigos
// valdymas, o paletei priklausymą keičia "Pašalinti iš paletės" veiksmas).
function EditItemModal({ item, onClose, onSave }) {
  const [form, setForm] = useState({
    ian: item.ian || "",
    name: item.name || "",
    quantity: item.quantity ?? 1,
    notes: item.notes || ""
  });
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    await onSave(item.id, form);
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink-950/50 p-0 sm:items-center sm:p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-panel sm:rounded-2xl"
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
              value={form.ian}
              onChange={(e) => setForm({ ...form, ian: e.target.value })}
              className="input-field font-mono"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pavadinimas</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="input-field"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Kiekis</label>
            <input
              type="number"
              min={1}
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              className="input-field"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pastaba</label>
            <textarea
              value={form.notes}
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
