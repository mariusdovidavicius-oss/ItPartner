import { useEffect, useRef, useState } from "react";
import { ScanLine, CheckCircle2, AlertCircle, AlertTriangle, Loader2, PackageCheck } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { computeDestination, prettifyDestination, UNCLASSIFIED } from "../lib/destination";

function formatPalletLabel(pallet) {
  if (!pallet) return "";
  const base = pallet.number ? `${pallet.number} paletė` : pallet.code;
  return `${base} — ${prettifyDestination(pallet.destination)}`;
}

export default function ScanEntry() {
  const [ian, setIan] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null); // { type: 'ok'|'warn'|'error', message }
  const [catalogNotFound, setCatalogNotFound] = useState(false);
  const [previewUnclassified, setPreviewUnclassified] = useState(false);
  const [openPallets, setOpenPallets] = useState([]); // atviros paletės su >0 prekių, sugrupuotos pagal destination
  const [loadingPallets, setLoadingPallets] = useState(true);
  const [closingId, setClosingId] = useState(null);
  const [closeMsg, setCloseMsg] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    loadOpenPallets();
  }, []);

  // Ieško IAN kodo kataloge (su debounce), automatiškai užpildo pavadinimą ir
  // rodo gyvą paskirties peržiūrą (tik UI patogumui — autoritetinga paieška
  // vyksta iš naujo handleSubmit metu, žr. komentarą ten).
  useEffect(() => {
    const trimmed = ian.trim();
    if (!trimmed) {
      setCatalogNotFound(false);
      setPreviewUnclassified(false);
      return;
    }
    const handle = setTimeout(async () => {
      const { data } = await supabase
        .from("catalog")
        .select("name, manufacturer, item_type")
        .eq("ian", trimmed)
        .maybeSingle();
      if (data?.name) {
        setName(data.name);
        setCatalogNotFound(false);
      } else {
        setCatalogNotFound(true);
      }
      setPreviewUnclassified(computeDestination(data?.manufacturer, data?.item_type) === UNCLASSIFIED);
    }, 400);
    return () => clearTimeout(handle);
  }, [ian]);

  // Kraunamos visos status='open' paletės su >0 prekių, sugrupuotos pagal paskirtį.
  async function loadOpenPallets() {
    setLoadingPallets(true);
    const { data: pallets } = await supabase
      .from("pallets")
      .select("id, code, number, destination")
      .eq("status", "open");

    const list = pallets || [];
    if (list.length === 0) {
      setOpenPallets([]);
      setLoadingPallets(false);
      return;
    }

    const { data: items } = await supabase
      .from("items")
      .select("pallet_id, quantity")
      .in("pallet_id", list.map((p) => p.id));

    const qtyMap = {};
    (items || []).forEach((i) => {
      if (i.pallet_id) qtyMap[i.pallet_id] = (qtyMap[i.pallet_id] || 0) + (i.quantity || 1);
    });

    const withQty = list
      .map((p) => ({ ...p, qty: qtyMap[p.id] || 0 }))
      .filter((p) => p.qty > 0)
      .sort((a, b) => prettifyDestination(a.destination).localeCompare(prettifyDestination(b.destination)));

    setOpenPallets(withQty);
    setLoadingPallets(false);
  }

  async function handleClose(pallet) {
    setClosingId(pallet.id);
    setCloseMsg("");
    const label = formatPalletLabel(pallet);
    await supabase.from("pallets").update({ status: "closed" }).eq("id", pallet.id);
    setCloseMsg(`${label} išvežta į sandėlį`);
    setClosingId(null);
    loadOpenPallets();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const trimmedIan = ian.trim();
    if (!trimmedIan) return;
    setSaving(true);
    setFeedback(null);
    setCloseMsg("");

    // Šviežia (ne debounce cache) katalogo užklausa — paskirtis nulemia KURIAI
    // paletei priklausys prekė, todėl čia svarbiau tikslumas nei greitis:
    // skeneriai dažnai įveda + Enter greičiau nei 400ms debounce.
    const { data: catalogRow } = await supabase
      .from("catalog")
      .select("name, manufacturer, item_type")
      .eq("ian", trimmedIan)
      .maybeSingle();

    const destination = computeDestination(catalogRow?.manufacturer, catalogRow?.item_type);
    const isUnclassified = destination === UNCLASSIFIED;

    // Rasti arba sukurti atvirą tos paskirties paletę
    const { data: existingPallet } = await supabase
      .from("pallets")
      .select("id, code, number, destination")
      .eq("status", "open")
      .eq("destination", destination)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let currentPallet = existingPallet;

    if (!currentPallet) {
      // Auto-sukurti naują paletę (number ir code nustato DB trigeris)
      const { data: newPallet, error: createError } = await supabase
        .from("pallets")
        .insert({ status: "open", destination })
        .select("id, code, number, destination")
        .single();

      if (createError) {
        setSaving(false);
        setFeedback({ type: "error", message: `Klaida kuriant paletę: ${createError.message}` });
        inputRef.current?.focus();
        return;
      }
      currentPallet = newPallet;
    }

    const palletLabel = formatPalletLabel(currentPallet);

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

    if (!hasError && isUnclassified) {
      feedbackMsg += " — trūksta gamintojo/tipo informacijos kataloge, patikrinkite.";
    }

    setSaving(false);

    if (hasError) {
      setFeedback({ type: "error", message: feedbackMsg });
    } else {
      setFeedback({ type: isUnclassified ? "warn" : "ok", message: feedbackMsg });
      setIan("");
      setName("");
      setCategory("");
      setNotes("");
      loadOpenPallets();
    }
    inputRef.current?.focus();
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Prekių registravimas</h1>
        <p className="mt-1 text-sm text-ink-600/70">
          Nuskenuokite IAN kodą — paskirtis (paletė) nustatoma automatiškai pagal katalogo
          gamintoją ir tipą.
        </p>
      </div>

      {/* Dabartinės atviros paletės */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-ink-800">Dabartinės atviros paletės</h2>
        {loadingPallets ? (
          <div className="panel flex items-center justify-center p-4">
            <Loader2 className="animate-spin text-ink-600/40" size={18} />
          </div>
        ) : openPallets.length === 0 ? (
          <div className="panel p-4 text-sm text-ink-600/50">
            Paletė bus sukurta automatiškai su pirmu skenavimu.
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {openPallets.map((p) => (
              <div key={p.id} className="panel flex items-center justify-between gap-3 p-3.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-ink-900">
                    {prettifyDestination(p.destination)}
                  </p>
                  <p className="text-xs text-ink-600/60">
                    {p.number ? `${p.number} paletė` : p.code} &middot; {p.qty} vnt.
                  </p>
                </div>
                <button
                  onClick={() => handleClose(p)}
                  disabled={closingId === p.id}
                  className="btn-secondary shrink-0"
                >
                  {closingId === p.id
                    ? <Loader2 size={14} className="animate-spin" />
                    : <PackageCheck size={14} />}
                  Išvežta
                </button>
              </div>
            ))}
          </div>
        )}
        {closeMsg && (
          <p className="flex items-center gap-1.5 text-xs font-medium text-signal-teal">
            <CheckCircle2 size={13} /> {closeMsg}
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

        {previewUnclassified && ian.trim() && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-signal-amber">
            <AlertTriangle size={13} />
            Paskirtis nenustatyta — prekė bus priskirta „Nepriskirta“ paletei
          </p>
        )}

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
                feedback.type === "ok"
                  ? "text-signal-teal"
                  : feedback.type === "warn"
                    ? "text-signal-amber"
                    : "text-signal-red"
              }`}
            >
              {feedback.type === "ok"
                ? <CheckCircle2 size={16} />
                : feedback.type === "warn"
                  ? <AlertTriangle size={16} />
                  : <AlertCircle size={16} />}
              {feedback.message}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
