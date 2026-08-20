import { useEffect, useState } from "react";
import { Loader2, UserPlus, X, AlertCircle, ShieldCheck, Save, Undo2, KeyRound, Copy, Check, Trash2 } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../lib/AuthProvider";
import {
  PERMISSIONS as PERMISSION_LABELS,
  PALLET_PERMISSIONS as PALLET_PERMISSION_LABELS,
  DEVICE_PERMISSIONS as DEVICE_PERMISSION_LABELS
} from "../lib/permissions";

// Set'ų lygybė — naudojama nustatyti, ar vartotojo eilutė turi neišsaugotų
// pakeitimų (juodraštis skiriasi nuo paskutinės iš DB įkeltos būsenos).
function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function draftFromUser(u) {
  return {
    is_admin: u.is_admin,
    permissions: new Set(u.permissions),
    palletPermissions: new Set(u.palletPermissions),
    devicePermissions: new Set(u.devicePermissions)
  };
}

function isDraftDirty(user, draft) {
  if (!draft) return false;
  return (
    draft.is_admin !== user.is_admin ||
    !setsEqual(draft.permissions, user.permissions) ||
    !setsEqual(draft.palletPermissions, user.palletPermissions) ||
    !setsEqual(draft.devicePermissions, user.devicePermissions)
  );
}

export default function PartsUsers() {
  const { session, user: currentUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [passwordTarget, setPasswordTarget] = useState(null); // { id, username } arba null
  // Juodraščiai — teisių žymimasis laukelis nebekeičia DB iškart; renkasi
  // kelis pakeitimus, tada paspaudžia "Išsaugoti" (žr. isDraftDirty žemiau).
  const [drafts, setDrafts] = useState({}); // userId -> { is_admin, permissions, palletPermissions, devicePermissions }
  const [savingAll, setSavingAll] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    const [{ data: profiles }, { data: perms }, { data: palletPerms }, { data: devicePerms }] = await Promise.all([
      supabase.from("profiles").select("id, username, is_admin").order("username"),
      supabase.from("user_permissions").select("user_id, permission"),
      supabase.from("pallet_permissions").select("user_id, permission"),
      supabase.from("device_permissions").select("user_id, permission")
    ]);
    const permsByUser = new Map();
    (perms || []).forEach((p) => {
      if (!permsByUser.has(p.user_id)) permsByUser.set(p.user_id, new Set());
      permsByUser.get(p.user_id).add(p.permission);
    });
    const palletPermsByUser = new Map();
    (palletPerms || []).forEach((p) => {
      if (!palletPermsByUser.has(p.user_id)) palletPermsByUser.set(p.user_id, new Set());
      palletPermsByUser.get(p.user_id).add(p.permission);
    });
    const devicePermsByUser = new Map();
    (devicePerms || []).forEach((p) => {
      if (!devicePermsByUser.has(p.user_id)) devicePermsByUser.set(p.user_id, new Set());
      devicePermsByUser.get(p.user_id).add(p.permission);
    });
    setUsers(
      (profiles || []).map((p) => ({
        ...p,
        permissions: permsByUser.get(p.id) || new Set(),
        palletPermissions: palletPermsByUser.get(p.id) || new Set(),
        devicePermissions: devicePermsByUser.get(p.id) || new Set()
      }))
    );
    setLoading(false);
  }

  // Pažymėjus žymimąjį laukelį — pakeičiamas TIK vietinis juodraštis, DB
  // dar nekeičiama (žr. saveUser žemiau, kuris siunčia visus surinktus
  // pakeitimus vienu metu paspaudus "Išsaugoti").
  function setDraftField(userId, field, perm, checked) {
    setDrafts((prev) => {
      const user = users.find((u) => u.id === userId);
      const base = prev[userId] || draftFromUser(user);
      const next = new Set(base[field]);
      if (checked) next.add(perm);
      else next.delete(perm);
      return { ...prev, [userId]: { ...base, [field]: next } };
    });
  }

  function setDraftAdmin(userId, checked) {
    setDrafts((prev) => {
      const user = users.find((u) => u.id === userId);
      const base = prev[userId] || draftFromUser(user);
      return { ...prev, [userId]: { ...base, is_admin: checked } };
    });
  }

  // Vieno laukelio ("permissions"/"palletPermissions"/"devicePermissions")
  // juodraščio ir DB būsenos skirtumas -> insert/delete užklausų sąrašas.
  function diffPermissionTasks(userId, table, liveSet, draftSet) {
    const tasks = [];
    for (const perm of draftSet) {
      if (!liveSet.has(perm)) tasks.push(supabase.from(table).insert({ user_id: userId, permission: perm }));
    }
    for (const perm of liveSet) {
      if (!draftSet.has(perm)) tasks.push(supabase.from(table).delete().eq("user_id", userId).eq("permission", perm));
    }
    return tasks;
  }

  // Vienas bendras "Išsaugoti" po visa lentele (ne po kiekvieną eilutę) —
  // sudeda visų juodraštį turinčių vartotojų pakeitimus į vieną užklausų
  // sąrašą ir siunčia visus iš karto.
  async function saveAllDrafts() {
    const dirtyUsers = users.filter((u) => isDraftDirty(u, drafts[u.id]));
    if (!dirtyUsers.length) return;

    setSavingAll(true);
    setActionError("");

    const tasks = [];
    for (const user of dirtyUsers) {
      const draft = drafts[user.id];
      tasks.push(
        ...diffPermissionTasks(user.id, "user_permissions", user.permissions, draft.permissions),
        ...diffPermissionTasks(user.id, "pallet_permissions", user.palletPermissions, draft.palletPermissions),
        ...diffPermissionTasks(user.id, "device_permissions", user.devicePermissions, draft.devicePermissions)
      );
      if (draft.is_admin !== user.is_admin) {
        tasks.push(supabase.from("profiles").update({ is_admin: draft.is_admin }).eq("id", user.id));
      }
    }

    const results = await Promise.all(tasks);
    setSavingAll(false);
    const failed = results.find((r) => r?.error);
    if (failed?.error) {
      setActionError(`Nepavyko išsaugoti: ${failed.error.message}`);
      return;
    }

    const dirtyIds = new Set(dirtyUsers.map((u) => u.id));
    setUsers((prev) => prev.map((u) => (dirtyIds.has(u.id) ? { ...u, ...drafts[u.id] } : u)));
    setDrafts({});
  }

  function cancelAllDrafts() {
    setDrafts({});
  }

  async function handleDeleteUser(user) {
    if (!confirm(`Ar tikrai norite ištrinti vartotoją „${user.username}“? Jo prisijungimas bus panaikintas negrįžtamai.`)) return;

    setDeletingId(user.id);
    setActionError("");
    try {
      const res = await fetch("/api/delete-user", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ userId: user.id })
      });
      const body = await res.json();
      if (!res.ok) {
        setActionError(body.error || "Nepavyko ištrinti vartotojo.");
        setDeletingId("");
        return;
      }
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[user.id];
        return next;
      });
      setDeletingId("");
    } catch {
      setActionError("Nepavyko pasiekti serverio (ar veikia /api/delete-user?).");
      setDeletingId("");
    }
  }

  const dirtyCount = users.filter((u) => isDraftDirty(u, drafts[u.id])).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Vartotojai</h1>
          <p className="mt-1 text-sm text-ink-600/70">
            Vartotojai ir jų teisės — priedų bei paletžų/siuntų moduliuose (nepriklausomos viena nuo kitos).
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
                  {PALLET_PERMISSION_LABELS.map((p) => (
                    <th key={p.key} className="px-3 py-2.5 text-center font-semibold text-ink-600/50">
                      {p.label} <span className="normal-case font-normal">(paletės)</span>
                    </th>
                  ))}
                  {DEVICE_PERMISSION_LABELS.map((p) => (
                    <th key={p.key} className="px-3 py-2.5 text-center font-semibold text-ink-600/50">
                      {p.label} <span className="normal-case font-normal">(prietaisai)</span>
                    </th>
                  ))}
                  <th className="px-3 py-2.5 text-center font-semibold">Admin</th>
                  <th className="w-0 px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-900/5">
                {users.map((u) => {
                  const draft = drafts[u.id];
                  const effective = draft || u;
                  const dirty = isDraftDirty(u, draft);
                  const saving = savingAll && dirty;
                  return (
                    <tr key={u.id} className={dirty ? "bg-signal-orange/[0.04]" : "hover:bg-ink-900/[0.015]"}>
                      <td className="px-3 py-2.5 font-medium text-ink-900">
                        {u.username}
                        {u.id === currentUser?.id && <span className="ml-1.5 text-xs text-ink-600/50">(jūs)</span>}
                      </td>
                      {PERMISSION_LABELS.map((p) => (
                        <td key={p.key} className="px-3 py-2.5 text-center">
                          <input
                            type="checkbox"
                            checked={effective.is_admin || effective.permissions.has(p.key)}
                            disabled={effective.is_admin || saving}
                            onChange={(e) => setDraftField(u.id, "permissions", p.key, e.target.checked)}
                            className="h-4 w-4 rounded border-ink-700/30 text-signal-orange focus:ring-signal-orange/30 disabled:opacity-40"
                          />
                        </td>
                      ))}
                      {PALLET_PERMISSION_LABELS.map((p) => (
                        <td key={p.key} className="px-3 py-2.5 text-center">
                          <input
                            type="checkbox"
                            checked={effective.is_admin || effective.palletPermissions.has(p.key)}
                            disabled={effective.is_admin || saving}
                            onChange={(e) => setDraftField(u.id, "palletPermissions", p.key, e.target.checked)}
                            className="h-4 w-4 rounded border-ink-700/30 text-signal-orange focus:ring-signal-orange/30 disabled:opacity-40"
                          />
                        </td>
                      ))}
                      {DEVICE_PERMISSION_LABELS.map((p) => (
                        <td key={p.key} className="px-3 py-2.5 text-center">
                          <input
                            type="checkbox"
                            checked={effective.is_admin || effective.devicePermissions.has(p.key)}
                            disabled={effective.is_admin || saving}
                            onChange={(e) => setDraftField(u.id, "devicePermissions", p.key, e.target.checked)}
                            className="h-4 w-4 rounded border-ink-700/30 text-signal-orange focus:ring-signal-orange/30 disabled:opacity-40"
                          />
                        </td>
                      ))}
                      <td className="px-3 py-2.5 text-center">
                        <input
                          type="checkbox"
                          checked={effective.is_admin}
                          disabled={saving || u.id === currentUser?.id}
                          onChange={(e) => setDraftAdmin(u.id, e.target.checked)}
                          className="h-4 w-4 rounded border-ink-700/30 text-signal-orange focus:ring-signal-orange/30 disabled:opacity-40"
                          title={u.id === currentUser?.id ? "Negalite atimti savo admin teisės" : undefined}
                        />
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-end gap-1.5">
                          {dirty && (
                            <span
                              className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal-orange"
                              title="Neišsaugoti pakeitimai"
                            />
                          )}
                          <button
                            type="button"
                            onClick={() => setPasswordTarget(u)}
                            disabled={saving}
                            className="shrink-0 rounded-lg p-1.5 text-ink-600/40 hover:bg-ink-900/5 hover:text-ink-900 disabled:opacity-40"
                            aria-label="Keisti slaptažodį"
                            title="Keisti slaptažodį"
                          >
                            <KeyRound size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteUser(u)}
                            disabled={saving || deletingId === u.id || u.id === currentUser?.id}
                            className="shrink-0 rounded-lg p-1.5 text-ink-600/40 hover:bg-signal-red/10 hover:text-signal-red disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-600/40"
                            aria-label="Ištrinti vartotoją"
                            title={u.id === currentUser?.id ? "Negalite ištrinti savo paskyros" : "Ištrinti vartotoją"}
                          >
                            {deletingId === u.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {dirtyCount > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-900/5 bg-signal-orange/[0.04] px-4 py-3">
            <p className="text-sm font-medium text-ink-800">
              Neišsaugotų pakeitimų: <strong>{dirtyCount}</strong>
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={cancelAllDrafts}
                disabled={savingAll}
                className="btn-secondary shrink-0 px-3 py-1.5"
              >
                <Undo2 size={14} /> Atšaukti
              </button>
              <button
                type="button"
                onClick={saveAllDrafts}
                disabled={savingAll}
                className="btn-primary shrink-0 px-3 py-1.5"
              >
                {savingAll ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Išsaugoti
              </button>
            </div>
          </div>
        )}
      </div>

      {creating && (
        <CreateUserModal
          accessToken={session?.access_token}
          onClose={() => setCreating(false)}
          onCreated={load}
        />
      )}

      {passwordTarget && (
        <PasswordModal
          accessToken={session?.access_token}
          user={passwordTarget}
          onClose={() => setPasswordTarget(null)}
        />
      )}
    </div>
  );
}

function CreateUserModal({ accessToken, onClose, onCreated }) {
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [permissions, setPermissions] = useState(new Set(["view"]));
  const [palletPermissions, setPalletPermissions] = useState(new Set());
  const [devicePermissions, setDevicePermissions] = useState(new Set());
  const [isAdmin, setIsAdmin] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);
  const passwordsMismatch = confirmPassword.length > 0 && password !== confirmPassword;

  function togglePerm(perm) {
    setPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(perm)) next.delete(perm);
      else next.add(perm);
      return next;
    });
  }

  function togglePalletPerm(perm) {
    setPalletPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(perm)) next.delete(perm);
      else next.add(perm);
      return next;
    });
  }

  function toggleDevicePerm(perm) {
    setDevicePermissions((prev) => {
      const next = new Set(prev);
      if (next.has(perm)) next.delete(perm);
      else next.add(perm);
      return next;
    });
  }

  async function submit(e) {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError("Slaptažodžiai nesutampa.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/create-user", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          id,
          password,
          permissions: [...permissions],
          palletPermissions: [...palletPermissions],
          devicePermissions: [...devicePermissions],
          isAdmin
        })
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Nepavyko sukurti vartotojo.");
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
      setDone(true);
      onCreated();
    } catch {
      setError("Nepavyko pasiekti serverio (ar veikia /api/create-user?).");
      setSubmitting(false);
    }
  }

  async function copyPassword() {
    await navigator.clipboard.writeText(password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink-950/50 p-0 sm:items-center sm:p-4">
      <form onSubmit={submit} className="max-h-[85vh] w-full max-w-sm overflow-y-auto rounded-t-2xl bg-white p-5 shadow-panel sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">Naujas vartotojas</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-ink-900/5">
            <X size={18} />
          </button>
        </div>

        {done ? (
          <div className="space-y-3">
            <p className="flex items-center gap-1.5 text-sm font-medium text-signal-teal">
              <ShieldCheck size={16} /> Vartotojas sukurtas.
            </p>
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">
                Slaptažodis ({id}) — nusikopijuokite dabar, vėliau jo peržiūrėti nebegalėsite
              </label>
              <div className="flex items-center gap-2">
                <input value={password} readOnly className="input-field font-mono" />
                <button type="button" onClick={copyPassword} className="btn-secondary shrink-0 px-2.5 py-2.5" aria-label="Kopijuoti slaptažodį">
                  {copied ? <Check size={15} className="text-signal-teal" /> : <Copy size={15} />}
                </button>
              </div>
            </div>
          </div>
        ) : (
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
              minLength={6}
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pakartokite slaptažodį</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="input-field"
              required
            />
            {passwordsMismatch && (
              <p className="mt-1 text-xs font-medium text-signal-red">Slaptažodžiai nesutampa.</p>
            )}
          </div>
          <div>
            <p className="mb-1.5 text-xs font-semibold text-ink-600/70">Priedų teisės</p>
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
          <div>
            <p className="mb-1.5 text-xs font-semibold text-ink-600/70">Paletžų / siuntų teisės</p>
            <div className="grid grid-cols-2 gap-2">
              {PALLET_PERMISSION_LABELS.map((p) => (
                <label key={p.key} className="flex items-center gap-2 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    checked={palletPermissions.has(p.key)}
                    disabled={isAdmin}
                    onChange={() => togglePalletPerm(p.key)}
                    className="h-4 w-4 rounded border-ink-700/30 text-signal-orange focus:ring-signal-orange/30"
                  />
                  {p.label}
                </label>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-semibold text-ink-600/70">Prietaisų teisės</p>
            <div className="grid grid-cols-2 gap-2">
              {DEVICE_PERMISSION_LABELS.map((p) => (
                <label key={p.key} className="flex items-center gap-2 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    checked={devicePermissions.has(p.key)}
                    disabled={isAdmin}
                    onChange={() => toggleDevicePerm(p.key)}
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
        )}

        {error && (
          <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-signal-red">
            <AlertCircle size={16} /> {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          {done ? (
            <button type="button" onClick={onClose} className="btn-primary">Uždaryti</button>
          ) : (
            <>
              <button type="button" onClick={onClose} className="btn-secondary">Atšaukti</button>
              <button type="submit" disabled={submitting || passwordsMismatch} className="btn-primary">
                {submitting && <Loader2 size={15} className="animate-spin" />}
                Sukurti
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

function PasswordModal({ accessToken, user, onClose }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);
  const passwordsMismatch = confirmPassword.length > 0 && password !== confirmPassword;

  async function copyPassword() {
    await navigator.clipboard.writeText(password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function submit(e) {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError("Slaptažodžiai nesutampa.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/update-user-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ userId: user.id, password })
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Nepavyko pakeisti slaptažodžio.");
        setSubmitting(false);
        return;
      }
      setDone(true);
      setSubmitting(false);
    } catch {
      setError("Nepavyko pasiekti serverio (ar veikia /api/update-user-password?).");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink-950/50 p-0 sm:items-center sm:p-4">
      <form onSubmit={submit} className="max-h-[85vh] w-full max-w-sm overflow-y-auto rounded-t-2xl bg-white p-5 shadow-panel sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">Keisti slaptažodį — {user.username}</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-ink-900/5">
            <X size={18} />
          </button>
        </div>

        {done ? (
          <div className="space-y-3">
            <p className="flex items-center gap-1.5 text-sm font-medium text-signal-teal">
              <ShieldCheck size={16} /> Slaptažodis pakeistas.
            </p>
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">
                Naujas slaptažodis — nusikopijuokite dabar, vėliau jo peržiūrėti nebegalėsite
              </label>
              <div className="flex items-center gap-2">
                <input value={password} readOnly className="input-field font-mono" />
                <button type="button" onClick={copyPassword} className="btn-secondary shrink-0 px-2.5 py-2.5" aria-label="Kopijuoti slaptažodį">
                  {copied ? <Check size={15} className="text-signal-teal" /> : <Copy size={15} />}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">Naujas slaptažodis</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input-field"
                minLength={6}
                required
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pakartokite slaptažodį</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="input-field"
                required
              />
              {passwordsMismatch && (
                <p className="mt-1 text-xs font-medium text-signal-red">Slaptažodžiai nesutampa.</p>
              )}
            </div>
          </div>
        )}

        {error && (
          <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-signal-red">
            <AlertCircle size={16} /> {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          {done ? (
            <button type="button" onClick={onClose} className="btn-primary">Uždaryti</button>
          ) : (
            <>
              <button type="button" onClick={onClose} className="btn-secondary">Atšaukti</button>
              <button type="submit" disabled={submitting || passwordsMismatch} className="btn-primary">
                {submitting && <Loader2 size={15} className="animate-spin" />}
                Išsaugoti
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
