import { useEffect, useRef, useState } from "react";
import { ScanLine, CheckCircle2, AlertCircle, Loader2, PackageCheck } from "lucide-react";
import { supabase } from "../lib/supabaseClient";

export default function ScanEntry() {
  const [ian, setIan] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null); // { type, message }
  const [catalogNotFound, setCatalogNotFound] = useState(false);
  const [openPallet, setOpenPallet] = useState(undefined); // undefined = kraunama, null = nėra
  const [palletItemCount, setPalletItemCount] = useState(0);
  const [palletItems, setPalletItems] = useState([]); // items dabartinėje paletėje
  const [closing, setClosing] = useState(false);
  const [closeMsg, setCloseMsg] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    loadOpenPallet();
  }, []);

  // Ieško IAN kodo kataloge (su debounce) ir automatiškai užpildo pavadinimą.
  useEffect(() => {
    const trimmed = ian.trim();
    if (!trimmed) {
      setCatalogNotFound(false);
      return;
    }
    const handle = setTimeout(async () => {
      const { data } = await supabase
        .from("catalog")
        .select("name")
        .eq("ian", trimmed)
        .maybeSingle();
      if (data?.name) {
        setName(data.name);
        setCatalogNotFound(false);
      } else {
        setCatalogNotFound(true);
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [ian]);

  // Vienintelė duomenų užkrovimo funkcija — kraunama pati paletė IR jos items kartu.
  async function loadOpenPallet() {
    const { data: pallet } = await supabase
      .from("pallets")
      .select("id, code, number")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    setOpenPallet(pallet ?? null);

    if (pallet) {
      const { data: items } = await supabase
        .from("items")
        .select("id, ian, name, quantity, updated_at")
        .eq("pallet_id", pallet.id)
        .order("updated_at", { ascending: false });
      const list = items || [];
      const total = list.reduce((s, i) => s + (i.quantity || 1), 0);
      setPalletItemCount(total);
      setPalletItems(list);
    } else {
      setPalletItemCount(0);
      setPalletItems([]);
    }
  }

  async function handleClose() {
    if (!openPallet) return;
    setClosing(true);
    setCloseMsg("");
    const palletLabel = openPallet.number ? `${openPallet.number} paletė` : openPallet.code;
    await supabase.from("pallets").update({ status: "closed" }).eq("id", openPallet.id);
    setCloseMsg(`${palletLabel} išvežta į sandėlį`);
    setClosing(false);
    loadOpenPallet(); // naujos atviros paletės nėra → sąrašas išsivalo
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const trimmedIan = ian.trim();
    if (!trimmedIan) return;
    setSaving(true);
    setFeedback(null);
    setCloseMsg("");

    let currentPallet = openPallet;

    if (!currentPallet) {
      // Auto-sukurti naują paletę (number ir code nustato DB trigeris)
      const { data: newPallet, error: createError } = await supabase
        .from("pallets")
        .insert({ status: "open" })
        .select("id, code, number")
        .single();

      if (createError) {
        setSaving(false);
        setFeedback({ type: "error", message: `Klaida kuriant paletę: ${createError.message}` });
        inputRef.current?.focus();
        return;
      }
      currentPallet = newPallet;
    }

    const palletLabel = currentPallet.number
      ? `${currentPallet.number} paletė`
      : currentPallet.code;

    // Ieškoti to paties IAN šioje paletėje
    const { data: existing } = await supabase
      .from("items")
      .select("id, quantity")
      .eq("ian", trimmedIan)
      .eq("pallet_id", currentPallet.id)
      .maybeSingle();

    let feedbackMsg = "";
    let hasError = false;

    if (existing) {
      const newQty = existing.quantity + 1;
      const { error } = await supabase
        .from("items")
        .update({ quantity: newQty })
        .eq("id", existing.id);
      if (error) {
        hasError = true;
        feedbackMsg = `Klaida atnaujinant: ${error.message}`;
      } else {
        feedbackMsg = `Užregistruota: ${trimmedIan} (dabar ${newQty} vnt. — ${palletLabel})`;
      }
    } else {
      const { error } = await supabase.from("items").insert({
        ian: trimmedIan,
        name: name.trim() || null,
        category: category.trim() || null,
        notes: notes.trim() || null,
        status: "packed",
        pallet_id: currentPallet.id,
        quantity: 1
      });
      if (error) {
        hasError = true;
        feedbackMsg = `Klaida įrašant: ${error.message}`;
      } else {
        feedbackMsg = `Užregistruota: ${trimmedIan} (1 vnt. — ${palletLabel})`;
      }
    }

    setSaving(false);

    if (hasError) {
      setFeedback({ type: "error", message: feedbackMsg });
    } else {
      setFeedback({ type: "ok", message: feedbackMsg });
      setIan("");
      setName("");
      setCategory("");
      setNotes("");
      loadOpenPallet(); // atnaujina ir kiekį, ir sąrašą
    }
    inputRef.current?.focus();
  }

  const palletLabel = openPallet?.number
    ? `${openPallet.number} paletė`
    : openPallet?.code ?? "";

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Prekių registravimas</h1>
        <p className="mt-1 text-sm text-ink-600/70">
          Nuskenuokite IAN kodą — kiekvienas skenavimas prideda 1 vnt. į dabartinę paletę.
        </p>
      </div>

      {/* Dabartinės paletės indikatorius */}
      <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
        {openPallet === undefined ? (
          <Loader2 className="animate-spin text-ink-600/40" size={18} />
        ) : openPallet ? (
          <>
            <div>
              <p className="text-[11px] font-mono uppercase tracking-widest text-ink-600/50">
                Dabartinė paletė
              </p>
              <p className="mt-0.5 text-base font-bold text-ink-900">{palletLabel}</p>
              <p className="text-xs text-ink-600/60">{palletItemCount} vnt. priskirta</p>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              {palletItemCount > 0 && (
                <button onClick={handleClose} disabled={closing} className="btn-primary">
                  {closing ? <Loader2 size={15} className="animate-spin" /> : <PackageCheck size={15} />}
                  Išvežta į sandėlį
                </button>
              )}
              {closeMsg && (
                <span className="flex items-center gap-1 text-xs font-medium text-signal-teal">
                  <CheckCircle2 size={13} />
                  {closeMsg}
                </span>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-ink-600/50">
            Paletė bus sukurta automatiškai su pirmu skenavimu
          </p>
        )}
      </div>

      {/* Skenerio forma */}
      <form
        onSubmit={handleSubmit}
        className="rounded-2xl bg-ink-950 p-5 shadow-panel lg:p-6"
      >
        <div className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-signal-orange">
          <ScanLine size={14} strokeWidth={2.5} />
          Skenerio įvestis
        </div>

        <div className="relative">
          <input
            ref={inputRef}
            value={ian}
            onChange={(e) => setIan(e.target.value)}
            placeholder="IAN-000000"
            autoComplete="off"
            className="w-full rounded-xl border border-white/10 bg-ink-900 px-4 py-4 font-mono text-lg tracking-wider text-white
              placeholder:text-white/20 outline-none focus:border-signal-orange focus:ring-2 focus:ring-signal-orange/30"
          />
          <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-mono text-xs text-white/20">
            ENTER
          </span>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Pavadinimas (nebūtina)"
              className="input-field bg-white/[0.06] border-white/10 text-white placeholder:text-white/30 focus:bg-white"
            />
            {catalogNotFound && (
              <p className="mt-1.5 text-xs text-signal-amber">
                Nerasta kataloge — įveskite pavadinimą rankiniu būdu
              </p>
            )}
          </div>
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Kategorija (nebūtina)"
            className="input-field bg-white/[0.06] border-white/10 text-white placeholder:text-white/30 focus:bg-white"
          />
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Pastaba (nebūtina)"
            className="input-field bg-white/[0.06] border-white/10 text-white placeholder:text-white/30 focus:bg-white"
          />
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button type="submit" disabled={saving || !ian.trim()} className="btn-primary">
            {saving ? <Loader2 size={16} className="animate-spin" /> : <ScanLine size={16} />}
            Registruoti
          </button>
          {feedback && (
            <span
              className={`flex items-center gap-1.5 text-sm font-medium ${
                feedback.type === "ok" ? "text-signal-teal" : "text-signal-red"
              }`}
            >
              {feedback.type === "ok" ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
              {feedback.message}
            </span>
          )}
        </div>
      </form>

      {/* Dabartinės paletės turinys */}
      <div className="panel p-4 lg:p-5">
        <h2 className="mb-3 text-sm font-semibold text-ink-800">Dabartinės paletės turinys</h2>
        {palletItems.length === 0 ? (
          <p className="text-sm text-ink-600/60">Paletė dar tuščia.</p>
        ) : (
          <ul className="divide-y divide-ink-900/5">
            {palletItems.map((item) => (
              <li key={item.id} className="flex items-center justify-between py-2.5">
                <div>
                  <p className="font-mono text-sm font-medium text-ink-900">{item.ian}</p>
                  {item.name && <p className="text-xs text-ink-600/60">{item.name}</p>}
                </div>
                <div className="text-right">
                  <p className="text-xs text-ink-600/50">
                    {new Date(item.updated_at).toLocaleDateString("lt-LT")}
                  </p>
                  <p className="text-xs font-medium text-ink-600/40">{item.quantity ?? 1} vnt.</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
