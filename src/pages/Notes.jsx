import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus, Loader2, AlertCircle, Search, Pin, Users, Lock, Archive, ArchiveRestore, Trash2, X,
  Check, Copy, NotebookPen, Palette
} from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../lib/AuthProvider";
import { foldLt, formatDateTime } from "../lib/format";

// Užrašinė — asmeniniai ir bendri užrašai. Asmeninį mato tik autorius,
// bendrą — visi, kas turi užrašinę (RLS, žr. supabase/migrate_add_notes.sql).
// Kortelės redaguojamos tiesiai sąraše (be atskiro lango) ir saugomos
// automatiškai rašant. Trynimas dviem žingsniais: pirma į archyvą, iš ten —
// grąžinti arba ištrinti. Bendrą užrašą vienu metu redaguojant dviem
// žmonėms laimi paskutinis išsaugojimas; kito pakeitimai kortelėje
// atsiranda realiu laiku, kai jos neredaguoji.

const SAVE_DELAY_MS = 700;
// Ilgas tekstas kortelėje auga iki šio aukščio, toliau — slenkamas viduje.
const BODY_MAX_PX = 420;

const COLORS = [
  { key: null, label: "Be spalvos", card: "border-ink-700/10 bg-white", dot: "bg-white" },
  { key: "yellow", label: "Geltona", card: "border-amber-200 bg-amber-50", dot: "bg-amber-200" },
  { key: "green", label: "Žalia", card: "border-emerald-200 bg-emerald-50", dot: "bg-emerald-200" },
  { key: "blue", label: "Mėlyna", card: "border-sky-200 bg-sky-50", dot: "bg-sky-200" },
  { key: "red", label: "Raudona", card: "border-rose-200 bg-rose-50", dot: "bg-rose-200" },
  { key: "violet", label: "Violetinė", card: "border-violet-200 bg-violet-50", dot: "bg-violet-200" }
];

function colorOf(key) {
  return COLORS.find((c) => c.key === (key || null)) || COLORS[0];
}

const VIEWS = [
  { key: "all", label: "Visi" },
  { key: "mine", label: "Asmeniniai" },
  { key: "shared", label: "Bendri" }
];

const VIEW_PREF_KEY = "notes.view";

function readView() {
  try {
    const v = localStorage.getItem(VIEW_PREF_KEY);
    return VIEWS.some((x) => x.key === v) ? v : "all";
  } catch {
    return "all";
  }
}

function writeView(v) {
  try {
    localStorage.setItem(VIEW_PREF_KEY, v);
  } catch {
    // privatus langas — tiesiog neįsimenama
  }
}

function matchesSearch(note, tokens) {
  if (!tokens.length) return true;
  const hay = foldLt(`${note.title}\n${note.body}`);
  return tokens.every((t) => hay.includes(t));
}

function snapshotOf(v) {
  return JSON.stringify({ title: v.title, body: v.body, color: v.color || null, pinned: v.pinned, shared: v.shared });
}

function IconButton({ onClick, title, active, activeClass = "text-signal-orange", disabled, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`rounded-lg p-1.5 transition hover:bg-ink-900/5 disabled:opacity-40 ${active ? activeClass : "text-ink-600/55"}`}
    >
      {children}
    </button>
  );
}

// Viena kortelė = vienas užrašas, redaguojamas vietoje. Naujas (juodraštis,
// dar be id) sukuriamas DB tik tada, kai jame atsiranda teksto; palikus jį
// tuščią — tiesiog dingsta.
function NoteCard({ note, mine, canDelete, names, autoFocus, onSaved, onPatch, onDelete, onDiscardDraft }) {
  const [values, setValues] = useState(() => ({
    title: note.title,
    body: note.body,
    color: note.color || null,
    pinned: note.pinned,
    shared: note.shared
  }));
  const [status, setStatus] = useState("idle"); // idle | saving | saved | error
  const [saveError, setSaveError] = useState("");
  const [showColors, setShowColors] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const idRef = useRef(note.id || null);
  const latest = useRef(values);
  latest.current = values;
  const savedSnapshot = useRef(snapshotOf(note));
  // Paskutinės žinomos DB versijos laikas — senesnis (pavėlavęs) atsakymas ignoruojamas.
  const savedAt = useRef(note.updated_at || "");
  const queue = useRef(Promise.resolve());
  const timer = useRef(null);
  const focused = useRef(false);
  const bodyRef = useRef(null);
  const archived = !!note.archived_at;

  // Išsaugojimai vykdomi iš eilės — kad greitai rašant naujas užrašas
  // nebūtų įterptas du kartus.
  const save = useCallback(() => {
    clearTimeout(timer.current);
    queue.current = queue.current.then(async () => {
      const v = latest.current;
      const snapshot = snapshotOf(v);
      if (snapshot === savedSnapshot.current) return;
      if (!idRef.current && !v.title.trim() && !v.body.trim()) return;

      setStatus("saving");
      const row = {
        title: v.title,
        body: v.body,
        color: v.color,
        pinned: v.pinned,
        ...(mine ? { shared: v.shared } : {})
      };
      const isNew = !idRef.current;
      const { data, error } = isNew
        ? await supabase.from("notes").insert(row).select().single()
        : await supabase.from("notes").update(row).eq("id", idRef.current).select().single();
      if (error) {
        setStatus("error");
        setSaveError(error.message);
        return;
      }
      idRef.current = data.id;
      savedSnapshot.current = snapshot;
      savedAt.current = data.updated_at;
      setSaveError("");
      setStatus(snapshotOf(latest.current) === snapshot ? "saved" : "saving");
      onSaved(data, isNew ? note._key : null);
    });
    return queue.current;
  }, [mine, onSaved, note._key]);

  // Tekstas — po trumpos pauzės; spalva / prisegimas / bendrinimas — iškart.
  function change(field, value, immediate = false) {
    setValues((prev) => ({ ...prev, [field]: value }));
    latest.current = { ...latest.current, [field]: value };
    clearTimeout(timer.current);
    if (immediate) save();
    else timer.current = setTimeout(save, SAVE_DELAY_MS);
  }

  // Išeinant iš puslapio / kortelei dingstant — neišsaugotas tekstas išsaugomas.
  useEffect(() => () => {
    if (timer.current) save();
  }, [save]);

  // Kitas žmogus pakeitė bendrą užrašą — perimama, jei šios kortelės dabar
  // neredaguoji ir joje nėra neišsaugotų pakeitimų.
  useEffect(() => {
    if (!note.id || focused.current) return;
    if (snapshotOf(latest.current) !== savedSnapshot.current) return;
    const remote = snapshotOf(note);
    if (remote === savedSnapshot.current || (note.updated_at || "") <= savedAt.current) return;
    savedSnapshot.current = remote;
    savedAt.current = note.updated_at;
    setValues({ title: note.title, body: note.body, color: note.color || null, pinned: note.pinned, shared: note.shared });
    setStatus("idle");
  }, [note]);

  // Teksto laukas auga kartu su tekstu (telefone patogiau nei vidinis slinkimas).
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), BODY_MAX_PX)}px`;
  }, [values.body]);

  function onFocus() {
    focused.current = true;
  }

  function onBlur(e) {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    focused.current = false;
    if (!idRef.current && !latest.current.title.trim() && !latest.current.body.trim()) {
      onDiscardDraft?.(note._key);
      return;
    }
    if (timer.current) save();
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText([values.title.trim(), values.body].filter(Boolean).join("\n\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // naršyklė neleido — nieko nedarom
    }
  }

  async function archive() {
    setBusy(true);
    await save();
    if (idRef.current) await onPatch(idRef.current, { archived_at: new Date().toISOString(), pinned: false });
    else onDiscardDraft?.(note._key);
    setBusy(false);
  }

  const authorName = !mine && note.created_by ? names[note.created_by] : null;
  const editorName = note.updated_by && note.updated_by !== note.created_by ? names[note.updated_by] : null;

  let meta;
  if (status === "saving") meta = "Saugoma…";
  else if (status === "error") meta = <span className="font-semibold text-signal-red">Neišsaugota: {saveError}</span>;
  else if (status === "saved") meta = "Išsaugota";
  else if (note.id) meta = formatDateTime(note.updated_at);
  else meta = "Naujas užrašas";

  return (
    <li className="mb-3 break-inside-avoid">
      <div
        onFocus={onFocus}
        onBlur={onBlur}
        className={`rounded-2xl border shadow-panel transition focus-within:shadow-md ${colorOf(values.color).card}`}
      >
        <div className="px-3.5 pt-3">
          <input
            value={values.title}
            onChange={(e) => change("title", e.target.value)}
            readOnly={archived}
            placeholder="Pavadinimas"
            className="w-full bg-transparent font-semibold text-ink-900 placeholder:text-ink-600/35 focus:outline-none"
          />
          <textarea
            ref={bodyRef}
            value={values.body}
            onChange={(e) => change("body", e.target.value)}
            readOnly={archived}
            autoFocus={autoFocus}
            rows={2}
            placeholder={archived ? "" : "Rašyk čia…"}
            className="mt-1 w-full resize-none bg-transparent text-sm leading-relaxed text-ink-800 placeholder:text-ink-600/35 focus:outline-none"
          />
        </div>

        {showColors && !archived && (
          <div className="flex items-center gap-1.5 px-3.5 pb-1">
            {COLORS.map((c) => (
              <button
                key={c.label}
                type="button"
                onClick={() => change("color", c.key, true)}
                className={`h-6 w-6 rounded-full border ${c.dot} ${
                  values.color === c.key ? "border-ink-900 ring-2 ring-ink-900/20" : "border-ink-700/20"
                }`}
                title={c.label}
                aria-label={c.label}
              />
            ))}
          </div>
        )}

        <div className="flex items-center gap-1 px-2 pb-1.5">
          <div className="min-w-0 flex-1 px-1.5 text-[11px] leading-tight text-ink-600/60">
            {values.shared ? (
              <span className="font-semibold text-signal-blue">
                Bendras{authorName && ` · ${authorName}`}
              </span>
            ) : (
              <span>Asmeninis</span>
            )}
            <span> · {meta}</span>
            {editorName && status === "idle" && <span className="block truncate">keitė {editorName}</span>}
          </div>

          {archived ? (
            <>
              <IconButton onClick={() => onPatch(note.id, { archived_at: null })} title="Grąžinti iš archyvo">
                <ArchiveRestore size={16} />
              </IconButton>
              {canDelete &&
                (confirmDelete ? (
                  <button
                    type="button"
                    onClick={async () => {
                      setBusy(true);
                      await onDelete(note.id);
                      setBusy(false);
                    }}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-lg bg-signal-red px-2 py-1 text-[11px] font-semibold text-white"
                  >
                    <Trash2 size={13} /> Tikrai ištrinti
                  </button>
                ) : (
                  <IconButton onClick={() => setConfirmDelete(true)} title="Ištrinti visam laikui">
                    <Trash2 size={16} />
                  </IconButton>
                ))}
            </>
          ) : (
            <>
              <IconButton onClick={() => change("pinned", !values.pinned, true)} title={values.pinned ? "Atsegti" : "Prisegti viršuje"} active={values.pinned}>
                <Pin size={16} className={values.pinned ? "fill-current" : ""} />
              </IconButton>
              <IconButton onClick={() => setShowColors((v) => !v)} title="Spalva" active={showColors} activeClass="text-ink-900">
                <Palette size={16} />
              </IconButton>
              {mine && (
                <IconButton
                  onClick={() => change("shared", !values.shared, true)}
                  title={values.shared ? "Bendras — paspausk, kad būtų asmeninis" : "Asmeninis — paspausk, kad būtų bendras"}
                  active={values.shared}
                  activeClass="text-signal-blue"
                >
                  {values.shared ? <Users size={16} /> : <Lock size={16} />}
                </IconButton>
              )}
              <IconButton onClick={copyText} title="Kopijuoti tekstą" active={copied} activeClass="text-signal-teal">
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </IconButton>
              <IconButton onClick={archive} title="Į archyvą" disabled={busy}>
                <Archive size={16} />
              </IconButton>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

let draftSeq = 0;

export default function Notes() {
  const { user, isAdmin } = useAuth();
  const [notes, setNotes] = useState([]);
  const [drafts, setDrafts] = useState([]); // nauji, dar neišsaugoti užrašai
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [view, setView] = useState(readView);
  const [showArchive, setShowArchive] = useState(false);
  const [names, setNames] = useState({});
  // Juodraštį išsaugojus, kortelė gauna id, bet React raktas lieka tas pats —
  // kitaip kortelė persikurtų ir rašant dingtų žymeklis.
  const keyById = useRef({});

  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase
      .from("notes")
      .select("*")
      .order("updated_at", { ascending: false });
    if (loadError) {
      setError(`Nepavyko įkelti užrašų: ${loadError.message}`);
      setLoading(false);
      return;
    }
    setError("");
    setNotes(data || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Bendrus užrašus keičia ir kiti — sąrašas atnaujinamas realiu laiku.
  useEffect(() => {
    let t;
    const ch = supabase
      .channel("notes-page")
      .on("postgres_changes", { event: "*", schema: "public", table: "notes" }, () => {
        clearTimeout(t);
        t = setTimeout(load, 600);
      })
      .subscribe();
    return () => {
      clearTimeout(t);
      supabase.removeChannel(ch);
    };
  }, [load]);

  // Kitų žmonių vardai (bendrų užrašų autoriai / keitėjai).
  useEffect(() => {
    const ids = new Set();
    notes.forEach((n) => {
      if (n.created_by !== user?.id) ids.add(n.created_by);
      if (n.updated_by && n.updated_by !== user?.id) ids.add(n.updated_by);
    });
    const missing = [...ids].filter((id) => !(id in names));
    if (!missing.length) return;
    supabase.rpc("note_people_names", { p_ids: missing }).then(({ data }) => {
      setNames((prev) => {
        const next = { ...prev };
        missing.forEach((id) => {
          next[id] = null;
        });
        (data || []).forEach((r) => {
          next[r.id] = r.username;
        });
        return next;
      });
    });
  }, [notes, user?.id, names]);

  const tokens = useMemo(() => foldLt(search.trim()).split(/\s+/).filter(Boolean), [search]);

  // Tvarka — pagal sukūrimą (naujausi viršuje), ne pagal paskutinį keitimą:
  // kitaip rašant kortelė šokinėtų į sąrašo viršų.
  const visible = useMemo(
    () =>
      notes
        .filter(
          (n) =>
            !!n.archived_at === showArchive &&
            (view === "all" || (view === "shared" ? n.shared : !n.shared)) &&
            matchesSearch(n, tokens)
        )
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
    [notes, showArchive, view, tokens]
  );
  const pinnedNotes = showArchive ? [] : visible.filter((n) => n.pinned);
  const otherNotes = showArchive ? visible : visible.filter((n) => !n.pinned);
  const archivedCount = notes.filter((n) => n.archived_at).length;
  const shownDrafts = showArchive ? [] : drafts;

  function changeView(v) {
    setView(v);
    writeView(v);
  }

  const handleSaved = useCallback((row, draftKey) => {
    if (draftKey) {
      keyById.current[row.id] = draftKey;
      setDrafts((prev) => prev.filter((d) => d._key !== draftKey));
    }
    setNotes((prev) => [row, ...prev.filter((n) => n.id !== row.id)]);
  }, []);

  const patchNote = useCallback(async (id, changes) => {
    const { data, error: patchError } = await supabase.from("notes").update(changes).eq("id", id).select().single();
    if (patchError) {
      setError(`Nepavyko išsaugoti: ${patchError.message}`);
      return false;
    }
    setNotes((prev) => [data, ...prev.filter((n) => n.id !== id)]);
    return true;
  }, []);

  const deleteNote = useCallback(async (id) => {
    const { error: delError } = await supabase.from("notes").delete().eq("id", id);
    if (delError) {
      setError(`Nepavyko ištrinti: ${delError.message}`);
      return false;
    }
    setNotes((prev) => prev.filter((n) => n.id !== id));
    return true;
  }, []);

  const discardDraft = useCallback((key) => {
    setDrafts((prev) => prev.filter((d) => d._key !== key));
  }, []);

  function addDraft() {
    if (showArchive) setShowArchive(false);
    draftSeq += 1;
    setDrafts((prev) => [
      {
        _key: `draft-${draftSeq}`,
        title: "",
        body: "",
        color: null,
        pinned: false,
        shared: view === "shared",
        created_by: user?.id
      },
      ...prev
    ]);
  }

  function renderCard(n, autoFocus = false) {
    const mine = n.created_by === user?.id;
    const key = n._key || keyById.current[n.id] || n.id;
    return (
      <NoteCard
        key={key}
        note={n._key ? n : { ...n, _key: key }}
        mine={mine}
        // Visam laikui ištrinti: autorius, arba adminas — kito bendrą (kaip RLS)
        canDelete={mine || (isAdmin && n.shared)}
        names={names}
        autoFocus={autoFocus}
        onSaved={handleSaved}
        onPatch={patchNote}
        onDelete={deleteNote}
        onDiscardDraft={discardDraft}
      />
    );
  }

  const nothing = visible.length === 0 && shownDrafts.length === 0;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Užrašinė</h1>
          <p className="mt-1 text-sm text-ink-600/70">
            Asmeninius užrašus matai tik tu, bendrus — visi, kas turi užrašinę.
          </p>
        </div>
        <button type="button" onClick={addDraft} className="btn-primary px-3.5">
          <Plus size={17} /> Naujas užrašas
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-signal-red/20 bg-signal-red/5 p-3.5 text-sm text-signal-red">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError("")} aria-label="Uždaryti">
            <X size={15} />
          </button>
        </div>
      )}

      <div className="space-y-3">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-600/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Ieškoti užrašuose…"
            className="input-field pl-9 text-base"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => changeView(v.key)}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                view === v.key
                  ? "border-ink-900 bg-ink-900 text-white"
                  : "border-ink-700/15 bg-white text-ink-700 hover:bg-ink-900/[0.03]"
              }`}
            >
              {v.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setShowArchive((v) => !v)}
            className={`ml-auto inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
              showArchive
                ? "border-ink-900 bg-ink-900 text-white"
                : "border-ink-700/15 bg-white text-ink-700 hover:bg-ink-900/[0.03]"
            }`}
          >
            <Archive size={13} /> Archyvas
            {archivedCount > 0 && <span className="opacity-60">{archivedCount}</span>}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-10 text-ink-600/50">
          <Loader2 className="animate-spin" size={20} />
        </div>
      ) : nothing ? (
        <div className="panel flex flex-col items-center gap-2 py-10 text-center">
          <NotebookPen className="text-ink-600/30" size={26} />
          <p className="text-sm text-ink-600/60">
            {tokens.length ? "Nieko nerasta." : showArchive ? "Archyvas tuščias." : "Užrašų dar nėra."}
          </p>
          {!tokens.length && !showArchive && (
            <button type="button" onClick={addDraft} className="btn-secondary mt-1 px-3 py-2 text-xs">
              <Plus size={14} /> Sukurti pirmą užrašą
            </button>
          )}
        </div>
      ) : (
        <>
          {pinnedNotes.length > 0 && (
            <section>
              <h2 className="mb-1.5 px-1 text-xs font-bold uppercase tracking-wide text-signal-orange">
                Prisegti <span className="font-semibold text-ink-600/40">{pinnedNotes.length}</span>
              </h2>
              <ul className="columns-1 gap-3 sm:columns-2 lg:columns-3">{pinnedNotes.map((n) => renderCard(n))}</ul>
            </section>
          )}
          {(otherNotes.length > 0 || shownDrafts.length > 0) && (
            <section>
              {pinnedNotes.length > 0 && (
                <h2 className="mb-1.5 px-1 text-xs font-bold uppercase tracking-wide text-ink-600/70">
                  Kiti <span className="font-semibold text-ink-600/40">{otherNotes.length}</span>
                </h2>
              )}
              <ul className="columns-1 gap-3 sm:columns-2 lg:columns-3">
                {/* Vienas masyvas: išsaugotas juodraštis lieka toje pačioje vietoje su tuo pačiu raktu */}
                {[...shownDrafts, ...otherNotes].map((n) => renderCard(n, !!n._key))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
