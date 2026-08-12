import { useState } from "react";
import { LogIn, Loader2, AlertCircle } from "lucide-react";
import { useAuth } from "../lib/AuthProvider";

// Puslapyje įterpiama prisijungimo forma — naudojama vietoj atskiro /login
// maršruto, kad vartotojas galėtų prisijungti neišeidamas iš puslapio,
// kurį jau peržiūri (sėkmingai prisijungus, AuthProvider sesija atsinaujina
// ir tėvinis komponentas pats persirenderina su prisijungusio turiniu).
// variant="panel" (numatytas) — pilna, paantraštėmis paženklinta forma
// (naudojama RequirePermission, kai visas puslapis reikalauja prisijungimo).
// variant="bar" — siaura, be antraščių, pritaikyta Layout.jsx viršutinei
// per visą pločio juostai (tamsus fonas, mažesni laukai).
export default function InlineLoginForm({ message, variant = "panel" }) {
  const { signInWithId } = useAuth();
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    const { error: signInError } = await signInWithId(id, password);
    setSubmitting(false);
    if (signInError) setError("Neteisingas ID arba slaptažodis.");
  }

  if (variant === "bar") {
    return (
      <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
        {message && <p className="text-xs text-white/50">{message}</p>}
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          autoComplete="username"
          placeholder="ID"
          required
          className="w-24 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs text-white placeholder:text-white/30 focus:border-signal-orange/50 focus:outline-none"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          placeholder="Slaptažodis"
          required
          className="w-28 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs text-white placeholder:text-white/30 focus:border-signal-orange/50 focus:outline-none"
        />
        <button
          type="submit"
          disabled={submitting}
          className="flex items-center gap-1 rounded-lg bg-signal-orange px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-signal-orange/90 disabled:opacity-60"
        >
          {submitting ? <Loader2 size={13} className="animate-spin" /> : <LogIn size={13} />}
          Prisijungti
        </button>
        {error && (
          <span className="flex items-center gap-1 text-xs font-medium text-signal-red">
            <AlertCircle size={13} className="shrink-0" /> {error}
          </span>
        )}
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="panel flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
      {message && <p className="text-sm text-ink-600/70 sm:basis-full">{message}</p>}
      <div className="min-w-[140px] flex-1">
        <label className="mb-1 block text-xs font-semibold text-ink-600/70">ID</label>
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          autoComplete="username"
          className="input-field"
          required
        />
      </div>
      <div className="min-w-[140px] flex-1">
        <label className="mb-1 block text-xs font-semibold text-ink-600/70">Slaptažodis</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="input-field"
          required
        />
      </div>
      <button type="submit" disabled={submitting} className="btn-primary shrink-0">
        {submitting ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}
        Prisijungti
      </button>
      {error && (
        <p className="flex items-center gap-1.5 text-sm font-medium text-signal-red sm:basis-full">
          <AlertCircle size={14} className="shrink-0" /> {error}
        </p>
      )}
    </form>
  );
}
