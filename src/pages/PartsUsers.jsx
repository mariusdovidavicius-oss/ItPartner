import { useEffect, useState } from "react";
import { Loader2, UserPlus, X, AlertCircle, ShieldCheck } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../lib/AuthProvider";
import { PERMISSIONS as PERMISSION_LABELS } from "../lib/permissions";

export default function PartsUsers() {
  const { session, user: currentUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busyKey, setBusyKey] = useState(""); // "<userId>:<perm>" arba "<userId>:admin" — kol vyksta atnaujinimas
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    const [{ data: profiles }, { data: perms }] = await Promise.all([
      supabase.from("profiles").select("id, username, is_admin").order("username"),
      supabase.from("user_permissions").select("user_id, permission")
    ]);
    const permsByUser = new Map();
    (perms || []).forEach((p) => {
      if (!permsByUser.has(p.user_id)) permsByUser.set(p.user_id, new Set());
      permsByUser.get(p.user_id).add(p.permission);
    });
    setUsers(
      (profiles || []).map((p) => ({ ...p, permissions: permsByUser.get(p.id) || new Set() }))
    );
    setLoading(false);
  }

  async function togglePermission(userId, perm, checked) {
    const key = `${userId}:${perm}`;
    setBusyKey(key);
    const { error } = checked
      ? await supabase.from("user_permissions").insert({ user_id: userId, permission: perm })
      : await supabase.from("user_permissions").delete().eq("user_id", userId).eq("permission", perm);
    setBusyKey("");
    if (error) {
      setActionError(`Nepavyko atnaujinti teisės: ${error.message}`);
      return;
    }
    setUsers((prev) =>
      prev.map((u) => {
        if (u.id !== userId) return u;
        const next = new Set(u.permissions);
        if (checked) next.add(perm);
        else next.delete(perm);
        return { ...u, permissions: next };
      })
    );
  }

  async function toggleAdmin(userId, checked) {
    const key = `${userId}:admin`;
    setBusyKey(key);
    const { error } = await supabase.from("profiles").update({ is_admin: checked }).eq("id", userId);
    setBusyKey("");
    if (error) {
      setActionError(`Nepavyko atnaujinti admin teisės: ${error.message}`);
      return;
    }
    setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, is_admin: checked } : u)));
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Vartotojai</h1>
          <p className="mt-1 text-sm text-ink-600/70">
            Priedų modulio vartotojai ir jų teisės.
          </p>
        </div>
        <button type="button" onClick={() => setCreating(true)} className="btn-primary shrink-0">
          <UserPlus size={15} /> Naujas vartotojas
        </button>
      </div>

      {actionError && (
        <div className="flex items-start gap-2 rounded-xl border border-signal-red/20 bg-signal-red/5 p-3.5 text-sm text-signal-red">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span className="flex-1">{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError("")}
            className="shrink-0 rounded-lg p-0.5 hover:bg-signal-red/10"
            aria-label="Uždaryti pranešimą"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className="panel overflow-hidden p-0">
        {loading ? (
          <div className="flex justify-center py-10 text-ink-600/50">
            <Loader2 className="animate-spin" size={20} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-ink-900/5 bg-ink-900/[0.02] text-xs uppercase tracking-wide text-ink-600/60">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">ID</th>
                  {PERMISSION_LABELS.map((p) => (
                    <th key={p.key} className="px-3 py-2.5 text-center font-semibold">{p.label}</th>
                  ))}
                  <th className="px-3 py-2.5 text-center font-semibold">Admin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-900/5">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-ink-900/[0.015]">
                    <td className="px-3 py-2.5 font-medium text-ink-900">
                      {u.username}
                      {u.id === currentUser?.id && <span className="ml-1.5 text-xs text-ink-600/50">(jūs)</span>}
                    </td>
                    {PERMISSION_LABELS.map((p) => (
                      <td key={p.key} className="px-3 py-2.5 text-center">
                        <input
                          type="checkbox"
                          checked={u.is_admin || u.permissions.has(p.key)}
                          disabled={u.is_admin || busyKey === `${u.id}:${p.key}`}
                          onChange={(e) => togglePermission(u.id, p.key, e.target.checked)}
                          className="h-4 w-4 rounded border-ink-700/30 text-signal-orange focus:ring-signal-orange/30 disabled:opacity-40"
                        />
                      </td>
                    ))}
                    <td className="px-3 py-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={u.is_admin}
                        disabled={busyKey === `${u.id}:admin` || u.id === currentUser?.id}
                        onChange={(e) => toggleAdmin(u.id, e.target.checked)}
                        className="h-4 w-4 rounded border-ink-700/30 text-signal-orange focus:ring-signal-orange/30 disabled:opacity-40"
                        title={u.id === currentUser?.id ? "Negalite atimti savo admin teisės" : undefined}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating && (
        <CreateUserModal
          accessToken={session?.access_token}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function CreateUserModal({ accessToken, onClose, onCreated }) {
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [permissions, setPermissions] = useState(new Set(["view"]));
  const [isAdmin, setIsAdmin] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  function togglePerm(perm) {
    setPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(perm)) next.delete(perm);
      else next.add(perm);
      return next;
    });
  }

  async function submit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/create-user", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ id, password, permissions: [...permissions], isAdmin })
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Nepavyko sukurti vartotojo.");
        setSubmitting(false);
        return;
      }
      onCreated();
    } catch {
      setError("Nepavyko pasiekti serverio (ar veikia /api/create-user?).");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink-950/50 p-0 sm:items-center sm:p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-t-2xl bg-white p-5 shadow-panel sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">Naujas vartotojas</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-ink-900/5">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">ID</label>
            <input value={id} onChange={(e) => setId(e.target.value)} className="input-field" required autoFocus />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Slaptažodis</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-field"
              required
            />
          </div>
          <div>
            <p className="mb-1.5 text-xs font-semibold text-ink-600/70">Teisės</p>
            <div className="grid grid-cols-2 gap-2">
              {PERMISSION_LABELS.map((p) => (
                <label key={p.key} className="flex items-center gap-2 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    checked={permissions.has(p.key)}
                    disabled={isAdmin}
                    onChange={() => togglePerm(p.key)}
                    className="h-4 w-4 rounded border-ink-700/30 text-signal-orange focus:ring-signal-orange/30"
                  />
                  {p.label}
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm font-medium text-ink-800">
            <input
              type="checkbox"
              checked={isAdmin}
              onChange={(e) => setIsAdmin(e.target.checked)}
              className="h-4 w-4 rounded border-ink-700/30 text-signal-orange focus:ring-signal-orange/30"
            />
            <ShieldCheck size={15} className="text-signal-orange" /> Administratorius (viską gali)
          </label>
        </div>

        {error && (
          <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-signal-red">
            <AlertCircle size={16} /> {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">Atšaukti</button>
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting && <Loader2 size={15} className="animate-spin" />}
            Sukurti
          </button>
        </div>
      </form>
    </div>
  );
}
