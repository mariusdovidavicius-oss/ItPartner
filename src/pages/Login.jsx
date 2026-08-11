import { useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { LogIn, Loader2, AlertCircle, Boxes } from "lucide-react";
import { useAuth } from "../lib/AuthProvider";

export default function Login() {
  const { user, loading, signInWithId } = useAuth();
  const location = useLocation();
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  if (!loading && user) {
    const from = location.state?.from || "/priedai";
    return <Navigate to={from} replace />;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    const { error: signInError } = await signInWithId(id, password);
    setSubmitting(false);
    if (signInError) {
      setError("Neteisingas ID arba slaptažodis.");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-900/[0.02] p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-2xl border border-ink-700/10 bg-white p-6 shadow-panel">
        <div className="mb-5 flex flex-col items-center gap-2 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-signal-orange/10 text-signal-orange">
            <Boxes size={22} />
          </div>
          <h1 className="text-lg font-bold text-ink-900">Priedų sandėlis</h1>
          <p className="text-sm text-ink-600/60">Prisijunkite, kad tęstumėte</p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">ID</label>
            <input
              value={id}
              onChange={(e) => setId(e.target.value)}
              autoComplete="username"
              autoFocus
              className="input-field"
              required
            />
          </div>
          <div>
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
        </div>

        {error && (
          <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-signal-red">
            <AlertCircle size={16} /> {error}
          </p>
        )}

        <button type="submit" disabled={submitting} className="btn-primary mt-5 w-full">
          {submitting ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}
          Prisijungti
        </button>
      </form>
    </div>
  );
}
