import { useEffect, useRef, useState } from "react";
import { ScanLine, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { supabase } from "../lib/supabaseClient";

export default function ScanEntry() {
  const [ian, setIan] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null); // { type: 'ok' | 'error', message }
  const [recent, setRecent] = useState([]);
  const [catalogNotFound, setCatalogNotFound] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    loadRecent();
  }, []);

  // Ieško IAN kodo kataloge (su debounce) ir automatiškai užpildo pavadinimą, jei randama.
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

  async function loadRecent() {
    const { data } = await supabase
      .from("items")
      .select("id, ian, name, status, created_at")
      .order("created_at", { ascending: false })
      .limit(6);
    setRecent(data || []);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!ian.trim()) return;
    setSaving(true);
    setFeedback(null);

    const { error } = await supabase.from("items").insert({
      ian: ian.trim(),
      name: name.trim() || null,
      category: category.trim() || null,
      notes: notes.trim() || null,
      status: "registered"
    });

    setSaving(false);

    if (error) {
      const isDuplicate = error.code === "23505";
      setFeedback({
        type: "error",
        message: isDuplicate
          ? `IAN kodas „${ian}“ jau užregistruotas.`
          : `Klaida įrašant: ${error.message}`
      });
    } else {
      setFeedback({ type: "ok", message: `Užregistruota: ${ian}` });
      setIan("");
      setName("");
      setCategory("");
      setNotes("");
      loadRecent();
    }
    inputRef.current?.focus();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Naujos prekės registravimas</h1>
        <p className="mt-1 text-sm text-ink-600/70">
          Nuskenuokite arba įveskite IAN kodą — skeneris veikia kaip klaviatūra, todėl laukas priims duomenis automatiškai.
        </p>
      </div>

      {/* Scanner terminal — signature element */}
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
                Nerasta kataloge - įveskite pavadinimą rankiniu būdu
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

      {/* Recent scans */}
      <div className="panel p-4 lg:p-5">
        <h2 className="mb-3 text-sm font-semibold text-ink-800">Paskutiniai įrašai</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-ink-600/60">Kol kas nieko neužregistruota.</p>
        ) : (
          <ul className="divide-y divide-ink-900/5">
            {recent.map((item) => (
              <li key={item.id} className="flex items-center justify-between py-2.5">
                <div>
                  <p className="font-mono text-sm font-medium text-ink-900">{item.ian}</p>
                  {item.name && <p className="text-xs text-ink-600/60">{item.name}</p>}
                </div>
                <span className="text-xs text-ink-600/50">
                  {new Date(item.created_at).toLocaleTimeString("lt-LT", {
                    hour: "2-digit",
                    minute: "2-digit"
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
