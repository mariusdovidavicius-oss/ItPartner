import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus, Loader2, AlertCircle, Check, ChevronDown, Trash2, CalendarDays, StickyNote, ListTodo,
  Star, GripVertical, Clock, X, ListChecks
} from "lucide-react";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors
} from "@dnd-kit/core";
import {
  SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../lib/AuthProvider";
import { localDateStr, addDaysStr, daysUntil, formatDue } from "../lib/tasks";
import { formatDate } from "../lib/format";

// Darbų sąrašas — asmeniniai priminimai vietoj lipnių lapelių. Matomas tik
// prisijungusiam savininkui (RLS, žr. supabase/migrate_add_tasks.sql); kol kas
// pats puslapis — tik adminui (App.jsx /darbai, Layout.jsx meniu).
// Pritaikyta telefonui: dideli varnelių mygtukai, Enter prideda darbą,
// kortelės tempiamos už rankenėlės (ne už visos kortelės — kitaip telefone
// slinkimas pirštu pradėtų tempimą).
//
// Tvarka grupės viduje: ⭐ svarbūs viršuje, toliau — rankinė tvarka
// (tasks.position). Tempiama tik savos grupės ribose; į kitą grupę darbas
// pereina pakeitus terminą (arba "Atidėti").

const DONE_LIMIT = 50;

const GROUPS = [
  { key: "overdue", label: "Vėluoja", tone: "text-signal-red" },
  { key: "today", label: "Šiandien", tone: "text-signal-orange" },
  { key: "later", label: "Vėliau", tone: "text-ink-700" },
  { key: "none", label: "Be termino", tone: "text-ink-600/70" }
];

// Kortelės viršutinė juosta, fonas ir termino ženkliukas — spalva pagal
// grupę. Švelnus fonas tik skubiems (vėluoja/šiandien) ir atliktiems —
// ramūs darbai lieka balti, kad skubūs išsiskirtų.
const CARD_ACCENT = {
  overdue: "border-t-signal-red bg-signal-red/[0.06]",
  today: "border-t-signal-orange bg-signal-orange/[0.07]",
  later: "border-t-signal-blue",
  none: "border-t-ink-600/20",
  done: "border-t-signal-teal bg-ink-900/[0.03]"
};
const DUE_CHIP = {
  overdue: "bg-signal-red/10 text-signal-red",
  today: "bg-signal-orange/10 text-signal-orange",
  later: "bg-signal-blue/10 text-signal-blue"
};

const SNOOZE_OPTIONS = [
  { label: "Rytoj", days: 1 },
  { label: "Po 3 dienų", days: 3 },
  { label: "Po savaitės", days: 7 }
];

function groupOf(task, today) {
  if (!task.due_date) return "none";
  const diff = daysUntil(task.due_date, today);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  return "later";
}

function byStarThenPosition(a, b) {
  return (b.starred - a.starred) || (a.position - b.position);
}

// crypto.randomUUID veikia tik saugiame kontekste (https/localhost) — telefone
// per http://<IP>:5173 jo nėra, todėl atsarginis variantas.
function newStepId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

// Termino pasirinkimas: greiti mygtukai + kalendorius. Naudojamas ir naujam
// darbui, ir redaguojant esamą.
function DuePicker({ value, onChange }) {
  const today = localDateStr();
  const tomorrow = addDaysStr(1);
  const options = [
    { label: "Be termino", value: "" },
    { label: "Šiandien", value: today },
    { label: "Rytoj", value: tomorrow }
  ];
  const isCustom = value && value !== today && value !== tomorrow;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
            value === o.value
              ? "border-signal-orange bg-signal-orange/10 text-signal-orange"
              : "border-ink-700/15 bg-white text-ink-700 hover:bg-ink-900/[0.03]"
          }`}
        >
          {o.label}
        </button>
      ))}
      <label
        className={`relative flex cursor-pointer items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
          isCustom
            ? "border-signal-orange bg-signal-orange/10 text-signal-orange"
            : "border-ink-700/15 bg-white text-ink-700 hover:bg-ink-900/[0.03]"
        }`}
      >
        <CalendarDays size={13} />
        {isCustom ? formatDue(value) : "Data"}
        <input
          type="date"
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
          aria-label="Pasirinkti datą"
        />
      </label>
    </div>
  );
}

function TaskEditor({ task, onSave, onDelete, onCancel }) {
  const [title, setTitle] = useState(task.title);
  const [note, setNote] = useState(task.note || "");
  const [dueDate, setDueDate] = useState(task.due_date || "");
  const [steps, setSteps] = useState(task.steps || []);
  const [newStep, setNewStep] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  function addStep() {
    const value = newStep.trim();
    if (!value) return;
    setSteps((prev) => [...prev, { id: newStepId(), title: value, done: false }]);
    setNewStep("");
  }

  function updateStep(id, changes) {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...changes } : s)));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    // Neišsaugotas, bet įrašytas naujas žingsnis irgi įtraukiamas.
    const pending = newStep.trim() ? [{ id: newStepId(), title: newStep.trim(), done: false }] : [];
    const cleanSteps = [...steps, ...pending]
      .map((s) => ({ ...s, title: s.title.trim() }))
      .filter((s) => s.title);
    await onSave({ title: title.trim(), note: note.trim() || null, due_date: dueDate || null, steps: cleanSteps });
    setSaving(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 px-4 py-3">
      <input value={title} onChange={(e) => setTitle(e.target.value)} className="input-field" autoFocus />
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Pastaba (nebūtina)"
        rows={2}
        className="input-field resize-y"
      />

      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-ink-600/70">Žingsniai</p>
        {steps.map((s) => (
          <div key={s.id} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => updateStep(s.id, { done: !s.done })}
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 ${
                s.done ? "border-signal-teal bg-signal-teal text-white" : "border-ink-700/25 text-transparent"
              }`}
              aria-label={s.done ? "Atžymėti žingsnį" : "Pažymėti žingsnį"}
            >
              <Check size={12} strokeWidth={3} />
            </button>
            <input
              value={s.title}
              onChange={(e) => updateStep(s.id, { title: e.target.value })}
              className={`input-field py-1.5 ${s.done ? "text-ink-600/50 line-through" : ""}`}
            />
            <button
              type="button"
              onClick={() => setSteps((prev) => prev.filter((x) => x.id !== s.id))}
              className="shrink-0 rounded-lg p-1.5 text-ink-600/40 hover:bg-signal-red/10 hover:text-signal-red"
              aria-label="Pašalinti žingsnį"
            >
              <X size={15} />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <input
            value={newStep}
            onChange={(e) => setNewStep(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addStep();
              }
            }}
            placeholder="+ Pridėti žingsnį"
            enterKeyHint="next"
            className="input-field py-1.5"
          />
          <button type="button" onClick={addStep} disabled={!newStep.trim()} className="btn-secondary shrink-0 px-2.5 py-1.5" aria-label="Pridėti žingsnį">
            <Plus size={15} />
          </button>
        </div>
      </div>

      <DuePicker value={dueDate} onChange={setDueDate} />
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button type="submit" disabled={saving || !title.trim()} className="btn-primary">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
          Išsaugoti
        </button>
        <button type="button" onClick={onCancel} className="btn-secondary">Atšaukti</button>
        <div className="ml-auto">
          {confirmDelete ? (
            <button
              type="button"
              onClick={onDelete}
              className="inline-flex items-center gap-1.5 rounded-lg bg-signal-red px-3 py-2.5 text-sm font-semibold text-white"
            >
              <Trash2 size={14} /> Tikrai ištrinti?
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2.5 text-sm font-medium text-ink-600/60 hover:bg-signal-red/10 hover:text-signal-red"
            >
              <Trash2 size={14} /> Ištrinti
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

function SnoozeButton({ onSnooze }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-ink-600/60 hover:bg-ink-900/5 hover:text-ink-800"
      >
        <Clock size={13} /> Atidėti
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 z-20 mb-1 w-36 overflow-hidden rounded-xl border border-ink-700/10 bg-white py-1 shadow-panel">
            {SNOOZE_OPTIONS.map((o) => (
              <button
                key={o.days}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onSnooze(addDaysStr(o.days));
                }}
                className="block w-full px-3 py-2 text-left text-sm text-ink-800 hover:bg-ink-900/5"
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TaskCard({ task, today, editing, sortable, onToggle, onEdit, onSave, onDelete, onCancel, onPatch }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: !sortable || editing
  });
  const style = { transform: CSS.Translate.toString(transform), transition };

  if (editing) {
    return (
      <li ref={setNodeRef} style={style} className="panel col-span-full overflow-hidden border-t-4 border-t-signal-orange p-0">
        <TaskEditor task={task} onSave={onSave} onDelete={onDelete} onCancel={onCancel} />
      </li>
    );
  }

  const group = task.done ? "done" : groupOf(task, today);
  const steps = task.steps || [];
  const stepsDone = steps.filter((s) => s.done).length;

  function toggleStep(id) {
    onPatch({ steps: steps.map((s) => (s.id === id ? { ...s, done: !s.done } : s)) });
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`panel relative flex flex-col border-t-4 p-0 ${CARD_ACCENT[group]} ${task.done ? "opacity-70" : ""} ${
        isDragging ? "z-10 shadow-lg ring-2 ring-signal-orange/30" : ""
      }`}
    >
      <div className="flex flex-1 items-start gap-2.5 p-3 pb-2">
        <button
          type="button"
          onClick={onToggle}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 transition active:scale-90 ${
            task.done
              ? "border-signal-teal bg-signal-teal text-white"
              : "border-ink-700/25 text-transparent hover:border-signal-teal hover:text-signal-teal/50"
          }`}
          aria-label={task.done ? "Grąžinti į neatliktus" : "Pažymėti atliktu"}
        >
          <Check size={15} strokeWidth={3} />
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <button type="button" onClick={onEdit} className="flex flex-col gap-1.5 text-left">
            <p className={`break-words pt-0.5 text-[15px] font-medium leading-snug ${task.done ? "text-ink-600/60 line-through" : "text-ink-900"}`}>
              {task.title}
            </p>
            {task.note && (
              <p className="flex gap-1.5 text-[13px] leading-snug text-ink-600/70">
                <StickyNote size={13} className="mt-0.5 shrink-0" />
                <span className="line-clamp-4 whitespace-pre-line break-words">{task.note}</span>
              </p>
            )}
          </button>

          {steps.length > 0 && (
            <ul className="space-y-1">
              {steps.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => toggleStep(s.id)}
                    className="flex w-full items-start gap-2 rounded-md py-0.5 text-left text-[13px] leading-snug hover:bg-ink-900/[0.03]"
                  >
                    <span
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 ${
                        s.done ? "border-signal-teal bg-signal-teal text-white" : "border-ink-700/25 text-transparent"
                      }`}
                    >
                      <Check size={10} strokeWidth={3.5} />
                    </span>
                    <span className={`break-words ${s.done ? "text-ink-600/50 line-through" : "text-ink-800"}`}>{s.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="-mr-1 -mt-1 flex shrink-0 flex-col items-center">
          <button
            type="button"
            onClick={() => onPatch({ starred: !task.starred })}
            className={`rounded-lg p-1.5 transition ${
              task.starred ? "text-signal-amber" : "text-ink-600/25 hover:text-signal-amber/70"
            }`}
            aria-label={task.starred ? "Nuimti žvaigždutę" : "Pažymėti svarbiu"}
          >
            <Star size={18} fill={task.starred ? "currentColor" : "none"} />
          </button>
          {sortable && (
            <button
              type="button"
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              className="cursor-grab touch-none rounded-lg p-1.5 text-ink-600/30 hover:bg-ink-900/5 hover:text-ink-600/70 active:cursor-grabbing"
              aria-label="Tempti, kad pakeistum tvarką"
            >
              <GripVertical size={18} />
            </button>
          )}
        </div>
      </div>

      <div className="flex min-h-[2.25rem] flex-wrap items-center gap-1.5 border-t border-ink-900/5 px-3 py-1.5">
        {task.done ? (
          <span className="text-xs text-ink-600/50">Atlikta {formatDate(task.done_at)}</span>
        ) : task.due_date ? (
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${DUE_CHIP[group]}`}>
            <CalendarDays size={12} /> {formatDue(task.due_date, today)}
          </span>
        ) : null}
        {steps.length > 0 && (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
              stepsDone === steps.length ? "bg-signal-teal/10 text-signal-teal" : "bg-ink-900/5 text-ink-600/70"
            }`}
          >
            <ListChecks size={12} /> {stepsDone}/{steps.length}
          </span>
        )}
        {!task.done && (
          <div className="ml-auto">
            <SnoozeButton onSnooze={(date) => onPatch({ due_date: date })} />
          </div>
        )}
      </div>
    </li>
  );
}

// Viena grupė — savas DndContext, todėl kortelę galima tempti tik grupės viduje.
function SortableGroup({ tasks, onReorder, children }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd({ active, over }) {
    if (!over || active.id === over.id) return;
    const from = tasks.findIndex((t) => t.id === active.id);
    const to = tasks.findIndex((t) => t.id === over.id);
    if (from < 0 || to < 0) return;
    const moved = arrayMove(tasks, from, to);
    // Nauja pozicija — tarp naujųjų kaimynų (keičiamas tik vienas įrašas).
    const prev = moved[to - 1]?.position;
    const next = moved[to + 1]?.position;
    let position;
    if (prev == null) position = next - 1;
    else if (next == null) position = prev + 1;
    else position = (prev + next) / 2;
    // ⭐ nekeičiama: nutempus ne-svarbų darbą tarp svarbių, jis lieka
    // pirmas po svarbiųjų (rikiavimas visada ⭐ → pozicija).
    onReorder(tasks[from], { position });
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={tasks.map((t) => t.id)} strategy={rectSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

export default function Tasks() {
  const { user } = useAuth();
  const [openTasks, setOpenTasks] = useState([]);
  const [doneTasks, setDoneTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const [today, setToday] = useState(localDateStr);
  const inputRef = useRef(null);

  async function load() {
    const [openRes, doneRes] = await Promise.all([
      supabase.from("tasks").select("*").eq("done", false).order("position", { ascending: true }),
      supabase.from("tasks").select("*").eq("done", true)
        .order("done_at", { ascending: false })
        .limit(DONE_LIMIT)
    ]);
    if (openRes.error || doneRes.error) {
      setError(`Nepavyko įkelti darbų: ${(openRes.error || doneRes.error).message}`);
    } else {
      setOpenTasks(openRes.data);
      setDoneTasks(doneRes.data);
      setError("");
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    const channel = supabase
      .channel("tasks-page")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, load)
      .subscribe();
    // Telefone puslapis gali ilgai gulėti fone — grįžus perskaičiuojama
    // "šiandien" ir atsisiunčiami kitur (pvz. kompiuteryje) atlikti pakeitimai.
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        setToday(localDateStr());
        load();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const grouped = useMemo(() => {
    const map = { overdue: [], today: [], later: [], none: [] };
    [...openTasks].sort(byStarThenPosition).forEach((t) => map[groupOf(t, today)].push(t));
    return map;
  }, [openTasks, today]);

  async function handleAdd(e) {
    e.preventDefault();
    const value = title.trim();
    if (!value) return;
    setAdding(true);
    const { data, error: insertError } = await supabase
      .from("tasks")
      .insert({ title: value, due_date: dueDate || null, created_by: user.id })
      .select()
      .single();
    setAdding(false);
    if (insertError) {
      setError(`Nepavyko pridėti: ${insertError.message}`);
      return;
    }
    setOpenTasks((prev) => (prev.some((t) => t.id === data.id) ? prev : [...prev, data]));
    setTitle("");
    setDueDate("");
    setError("");
    inputRef.current?.focus();
  }

  // Smulkūs pakeitimai (⭐, žingsnio varnelė, atidėjimas, tvarka) parodomi
  // iš karto, be laukimo DB — telefone kitaip atrodytų, kad paspaudimas
  // nesuveikė. Nepavykus — perkraunama iš DB.
  async function patchTask(task, changes) {
    const apply = (list) => list.map((t) => (t.id === task.id ? { ...t, ...changes } : t));
    setOpenTasks(apply);
    setDoneTasks(apply);
    const { error: updateError } = await supabase.from("tasks").update(changes).eq("id", task.id);
    if (updateError) {
      setError(`Nepavyko pakeisti: ${updateError.message}`);
      load();
    }
  }

  async function handleToggle(task) {
    const done = !task.done;
    const updated = { ...task, done, done_at: done ? new Date().toISOString() : null };
    if (done) {
      setOpenTasks((prev) => prev.filter((t) => t.id !== task.id));
      setDoneTasks((prev) => [updated, ...prev]);
    } else {
      setDoneTasks((prev) => prev.filter((t) => t.id !== task.id));
      setOpenTasks((prev) => [...prev, updated]);
    }
    const { error: updateError } = await supabase.from("tasks").update({ done }).eq("id", task.id);
    if (updateError) {
      setError(`Nepavyko pakeisti: ${updateError.message}`);
      load();
    }
  }

  async function handleSave(task, changes) {
    const { error: updateError } = await supabase.from("tasks").update(changes).eq("id", task.id);
    if (updateError) {
      setError(`Nepavyko išsaugoti: ${updateError.message}`);
      return;
    }
    const apply = (list) => list.map((t) => (t.id === task.id ? { ...t, ...changes } : t));
    setOpenTasks(apply);
    setDoneTasks(apply);
    setEditingId(null);
    setError("");
  }

  async function handleDelete(task) {
    const { error: deleteError } = await supabase.from("tasks").delete().eq("id", task.id);
    if (deleteError) {
      setError(`Nepavyko ištrinti: ${deleteError.message}`);
      return;
    }
    setOpenTasks((prev) => prev.filter((t) => t.id !== task.id));
    setDoneTasks((prev) => prev.filter((t) => t.id !== task.id));
    setEditingId(null);
  }

  function renderCard(task, sortable) {
    return (
      <TaskCard
        key={task.id}
        task={task}
        today={today}
        sortable={sortable}
        editing={editingId === task.id}
        onToggle={() => handleToggle(task)}
        onEdit={() => setEditingId(task.id)}
        onSave={(changes) => handleSave(task, changes)}
        onDelete={() => handleDelete(task)}
        onCancel={() => setEditingId(null)}
        onPatch={(changes) => patchTask(task, changes)}
      />
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Darbai</h1>
        <p className="mt-1 text-sm text-ink-600/70">Tavo darbų sąrašas — matai tik tu.</p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-signal-red/20 bg-signal-red/5 p-3.5 text-sm text-signal-red">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      <form onSubmit={handleAdd} className="panel space-y-3 p-3.5">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Naujas darbas… (pvz. atkrauti Lidl paletę)"
            enterKeyHint="done"
            className="input-field text-base"
          />
          <button type="submit" disabled={adding || !title.trim()} className="btn-primary shrink-0 px-3.5" aria-label="Pridėti">
            {adding ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />}
          </button>
        </div>
        <DuePicker value={dueDate} onChange={setDueDate} />
      </form>

      {loading ? (
        <div className="flex justify-center py-10 text-ink-600/50">
          <Loader2 className="animate-spin" size={20} />
        </div>
      ) : (
        <>
          {openTasks.length === 0 && (
            <div className="panel flex flex-col items-center gap-2 py-10 text-center">
              <ListTodo className="text-ink-600/30" size={26} />
              <p className="text-sm text-ink-600/60">Neatliktų darbų nėra.</p>
            </div>
          )}

          {GROUPS.filter((g) => grouped[g.key].length > 0).map((g) => (
            <section key={g.key}>
              <h2 className={`mb-1.5 px-1 text-xs font-bold uppercase tracking-wide ${g.tone}`}>
                {g.label} <span className="font-semibold text-ink-600/40">{grouped[g.key].length}</span>
              </h2>
              <SortableGroup tasks={grouped[g.key]} onReorder={patchTask}>
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {grouped[g.key].map((t) => renderCard(t, true))}
                </ul>
              </SortableGroup>
            </section>
          ))}

          {doneTasks.length > 0 && (
            <section>
              <button
                type="button"
                onClick={() => setShowDone((v) => !v)}
                className="mb-1.5 flex items-center gap-1 px-1 text-xs font-bold uppercase tracking-wide text-ink-600/60 hover:text-ink-700"
              >
                <ChevronDown size={14} className={`transition-transform ${showDone ? "" : "-rotate-90"}`} />
                Atlikti <span className="font-semibold text-ink-600/40">{doneTasks.length}{doneTasks.length >= DONE_LIMIT && "+"}</span>
              </button>
              {showDone && (
                <SortableGroup tasks={[]} onReorder={() => {}}>
                  <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {doneTasks.map((t) => renderCard(t, false))}
                  </ul>
                </SortableGroup>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
