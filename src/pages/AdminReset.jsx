import { useState } from "react";
import { AlertTriangle, Trash2, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { supabase } from "../lib/supabaseClient";

const CONFIRM_WORD = "IŠVALYTI";

export default function AdminReset() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null); // { ok: bool, message: string }

  const confirmed = input === CONFIRM_WORD;

  async function handleReset() {
    if (!confirmed) return;
    setLoading(true);
    setResult(null);

    const { error } = await supabase.rpc("reset_test_data");

    setLoading(false);

    if (error) {
      setResult({ ok: false, message: `Klaida: ${error.message}` });
    } else {
      setInput("");
      setResult({ ok: true, message: "Visi duomenys ištrinti. Paletžų numeracija grąžinta į 1." });
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Administravimas</h1>
        <p className="mt-1 text-sm text-ink-600/70">
          Testavimo duomenų išvalymas. Puslapis nepasiekiamas per navigaciją.
        </p>
      </div>

      {/* Perspėjimas */}
      <div className="flex gap-3 rounded-2xl border border-signal-red/25 bg-signal-red/5 p-4">
        <AlertTriangle size={20} className="mt-0.5 shrink-0 text-signal-red" />
        <div className="space-y-1 text-sm text-signal-red">
          <p className="font-bold">DĖMESIO: veiksmas negrįžtamas</p>
          <p>
            Šis veiksmas negrįžtamai ištrins <strong>VISUS</strong> prekių, paletžų ir
            siuntų įrašus duomenų bazėje. Naudokite tik testavimui.
          </p>
        </div>
      </div>

      {/* Patvirtinimo forma */}
      <div className="panel space-y-4 p-4 lg:p-5">
        <div>
          <label className="mb-1.5 block text-xs font-semibold text-ink-600/70">
            Įveskite <span className="font-mono font-bold text-ink-900">{CONFIRM_WORD}</span>, kad patvirtintumėte
          </label>
          <input
            value={input}
            onChange={(e) => { setInput(e.target.value); setResult(null); }}
            placeholder={CONFIRM_WORD}
            autoComplete="off"
            className="input-field font-mono"
          />
        </div>

        <button
          onClick={handleReset}
          disabled={!confirmed || loading}
          className="btn-primary w-full justify-center bg-signal-red hover:bg-signal-red/90"
        >
          {loading
            ? <Loader2 size={16} className="animate-spin" />
            : <Trash2 size={16} />}
          Ištrinti visus duomenis
        </button>

        {result && (
          <div
            className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${
              result.ok
                ? "border-signal-teal/20 bg-signal-teal/5 text-signal-teal"
                : "border-signal-red/20 bg-signal-red/5 text-signal-red"
            }`}
          >
            {result.ok
              ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
              : <AlertCircle size={16} className="mt-0.5 shrink-0" />}
            {result.message}
          </div>
        )}
      </div>
    </div>
  );
}
