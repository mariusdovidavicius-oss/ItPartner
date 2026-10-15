import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus, Loader2, AlertCircle, Check, ChevronDown, Trash2, CalendarDays, StickyNote, ListTodo,
  Star, GripVertical, Clock, X, ListChecks, Package, MapPin, UserRound, Bell, BellOff
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
import { getPushState, enablePush, disablePush, resyncPush, sendPush, needsHomeScreenInstall } from "../lib/push";

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

// Išsiuntimo darbams (sukurtiems iš /priedai "Paruošti išsiuntimui") kartu
// pakraunamas priedas su vietomis — kortelėje iškart matosi, kur jis guli.
// writeoffs — šio darbo nurašymai (matomi tik turintiems 'delete' teisę).
const TASK_SELECT =
  "*, part:parts(id, name, part_code, main_model, price, part_stock(id, location, quantity, warehouses(name))), " +
  "writeoffs:parts_writeoffs(id, quantity, undone_at)";

const GROUPS = [
  { key: "overdue", label: "Vėluoja", tone: "text-signal-red" },
  { key: "today", label: "Šiandien", tone: "text-signal-orange" },
  { key: "later", label: "Vėliau", tone: "text-ink-700" },
  { key: "none", label: "Be termino", tone: "text-ink-600/70" }
];

// Kortelės viršutinė juosta, fonas ir termino ženkliukas — spalva pagal
// grupę. Švelnus fonas tik skubiems (vėluoja/šiandien) ir atliktiems —
// ramūs darbai lieka balti, kad skubūs išsiskirtų.
// Išsiuntimo darbų juosta — violetinė (kitokia nei grupių), kad tarp
// priminimų išsiskirtų; fonas vis tiek pagal skubumą.
const CARD_BORDER = {
  overdue: "border-t-signal-red",
  today: "border-t-signal-orange",
  later: "border-t-signal-blue",
  none: "border-t-ink-600/20",
  done: "border-t-signal-teal"
};
const CARD_BG = {
  overdue: "bg-signal-red/[0.06]",
  today: "bg-signal-orange/[0.07]",
  later: "bg-white",
  none: "bg-white",
  done: "bg-ink-900/[0.03]"
};

const FILTERS = [
  { key: "all", label: "Visi" },
  { key: "ship", label: "Išsiuntimai" },
  { key: "own", label: "Priminimai" }
];

// Perbraukimas telefone: kiek pikselių reikia, kad suveiktų.
const SWIPE_THRESHOLD = 90;

function isShipTask(task) {
  return !!(task.part_id || task.quantity);
}

// Filtras "Visi / Išsiuntimai / Priminimai".
function matchesFilter(task, filter) {
  return filter === "all" || (filter === "ship") === isShipTask(task);
}

// Kiek laiko užsakymas laukia ("15 min.", "3 val.", "2 d.").
function formatAge(createdAt, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 60000));
  if (minutes < 1) return "ką tik";
  if (minutes < 60) return `${minutes} min.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} val.`;
  return `${Math.floor(hours / 24)} d.`;
}

// Vieta, iš kurios siūloma imti (daugiausia vienetų) — rikiavimui pagal vietą.
function mainLocation(task) {
  return stockPlaces(task.part)[0]?.location ?? null;
}

// "8" prieš "42" (skaitine tvarka); be vietos — gale.
function byLocation(a, b) {
  const la = mainLocation(a);
  const lb = mainLocation(b);
  if (la == null || lb == null) return (la == null) - (lb == null);
  return String(la).localeCompare(String(lb), undefined, { numeric: true });
}

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // privatus langas ir pan. — nustatymas tiesiog neišsaugomas
  }
}
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

// Priedo blokas išsiuntimo darbo kortelėje: kiekis, kodas, užsakymo nr.,
// vietos su likučiu (daugiausia vienetų turinti — pirma) ir kas pažymėjo.
function ShipInfo({ task, fromName }) {
  const part = task.part;
  const places = stockPlaces(part);
  const writtenOff = activeWriteoffs(task).reduce((sum, w) => sum + w.quantity, 0);
  return (
    <div className="space-y-1 rounded-lg bg-violet-500/[0.07] px-2.5 py-2 text-[13px] leading-snug text-ink-800">
      <p className="flex flex-wrap items-center gap-x-1.5">
        <Package size={13} className="shrink-0 text-violet-600" />
        <span className="font-semibold">{task.quantity ?? 1} vnt.</span>
        {part?.part_code && <span className="font-mono text-ink-600/80">{part.part_code}</span>}
        {task.order_ref && <span className="text-ink-600/80">· užs. {task.order_ref}</span>}
        {task.unit_price != null && <span className="text-ink-600/80">· {Number(task.unit_price).toFixed(2)} €/vnt.</span>}
      </p>
      {task.done ? (
        <p className={writtenOff > 0 ? "font-semibold text-signal-teal" : "text-ink-600/60"}>
          {writtenOff > 0 ? `Nurašyta ${writtenOff} vnt.` : "Nenurašyta"}
        </p>
      ) : part ? (
        places.length > 0 ? (
          <p className="flex gap-1.5">
            <MapPin size={13} className="mt-0.5 shrink-0 text-violet-600" />
            <span>
              {places.map((s, i) => (
                <span key={i}>
                  {i > 0 && ", "}
                  {s.warehouses?.name && `${s.warehouses.name} — `}
                  <span className="font-bold">{s.location}</span> ({s.quantity})
                </span>
              ))}
            </span>
          </p>
        ) : (
          <p className="text-signal-red">Likutyje nėra</p>
        )
      ) : (
        <p className="text-ink-600/60">Priedas ištrintas</p>
      )}
      {fromName && (
        <p className="flex items-center gap-1.5 text-ink-600/70">
          <UserRound size={13} className="shrink-0" /> Nuo: {fromName}
        </p>
      )}
    </div>
  );
}

function TaskCard({ task, today, editing, sortable, fromName, onToggle, onEdit, onSave, onDelete, onCancel, onPatch }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: !sortable || editing
  });
  const style = { transform: CSS.Translate.toString(transform), transition };
  const swipe = useRef(null); // { x, y, axis } — perbraukimo pradžia
  const [swipeDx, setSwipeDx] = useState(0);

  if (editing) {
    return (
      <li ref={setNodeRef} style={style} className="panel col-span-full overflow-hidden border-t-4 border-t-signal-orange p-0">
        <TaskEditor task={task} onSave={onSave} onDelete={onDelete} onCancel={onCancel} />
      </li>
    );
  }

  const group = task.done ? "done" : groupOf(task, today);
  const ship = isShipTask(task);
  const border = ship && !task.done ? "border-t-violet-500" : CARD_BORDER[group];
  const steps = task.steps || [];
  const stepsDone = steps.filter((s) => s.done).length;
  const ageHours = (Date.now() - new Date(task.created_at).getTime()) / 3600000;

  function toggleStep(id) {
    onPatch({ steps: steps.map((s) => (s.id === id ? { ...s, done: !s.done } : s)) });
  }

  // Perbraukimas telefone: į dešinę — atlikta (ar grąžinta), į kairę —
  // atidėti rytojui. Vertikalų slinkimą palieka naršyklei (touch-action:
  // pan-y); tempimo rankenėlė (data-grip) perbraukimo nepradeda.
  function onTouchStart(e) {
    if (e.target.closest("[data-grip]")) return;
    const t = e.touches[0];
    swipe.current = { x: t.clientX, y: t.clientY, axis: null };
  }

  function onTouchMove(e) {
    const s = swipe.current;
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (!s.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      s.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (s.axis !== "x") return;
    // Atliktų darbų į kairę (atidėti) nebraukiama.
    setSwipeDx(task.done ? Math.max(0, dx) : dx);
  }

  function onTouchEnd() {
    const dx = swipeDx;
    swipe.current = null;
    setSwipeDx(0);
    if (dx > SWIPE_THRESHOLD) onToggle();
    else if (dx < -SWIPE_THRESHOLD) onPatch({ due_date: addDaysStr(1) });
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`panel relative flex flex-col overflow-hidden border-t-4 p-0 ${border} ${task.done ? "opacity-70" : ""} ${
        isDragging ? "z-10 shadow-lg ring-2 ring-signal-orange/30" : ""
      }`}
    >
      {swipeDx !== 0 && (
        <div
          className={`absolute inset-0 flex items-center px-4 text-sm font-semibold text-white ${
            swipeDx > 0 ? "justify-start bg-signal-teal" : "justify-end bg-signal-amber"
          }`}
        >
          {swipeDx > 0 ? (
            <span className="flex items-center gap-1.5"><Check size={16} /> {task.done ? "Grąžinti" : "Atlikta"}</span>
          ) : (
            <span className="flex items-center gap-1.5"><Clock size={16} /> Rytoj</span>
          )}
        </div>
      )}
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={() => { swipe.current = null; setSwipeDx(0); }}
        style={{
          transform: swipeDx ? `translateX(${swipeDx}px)` : undefined,
          transition: swipe.current ? "none" : "transform 150ms ease-out",
          touchAction: "pan-y"
        }}
        className="relative flex flex-1 flex-col bg-white"
      >
      <div className={`flex flex-1 flex-col ${CARD_BG[group]}`}>
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

          {(task.part_id || task.quantity) && <ShipInfo task={task} fromName={fromName} />}
          {!task.part_id && !task.quantity && fromName && (
            <p className="flex items-center gap-1.5 text-[13px] text-ink-600/70">
              <UserRound size={13} className="shrink-0" /> Nuo: {fromName}
            </p>
          )}

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
              data-grip
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
        {ship && (
          <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-xs font-semibold text-violet-700">
            <Package size={12} /> Išsiuntimas
          </span>
        )}
        {ship && !task.done && (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
              ageHours >= 24 ? "bg-signal-red/10 text-signal-red" : "bg-ink-900/5 text-ink-600/70"
            }`}
            title={`Pažymėta ${formatDate(task.created_at)}`}
          >
            <Clock size={12} /> Laukia {formatAge(task.created_at)}
          </span>
        )}
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
      </div>
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

function activeWriteoffs(task) {
  return (task.writeoffs || []).filter((w) => !w.undone_at);
}

// Vietos, iš kurių siūloma nurašyti: pirma ta, kur daugiausia vienetų.
function stockPlaces(part) {
  return (part?.part_stock || [])
    .filter((s) => (s.quantity ?? 0) > 0)
    .sort((a, b) => (b.quantity ?? 0) - (a.quantity ?? 0));
}

// "Atkrauta — nurašyti?" — užbaigiant išsiuntimo darbą. Kiekis iš anksto
// paskirstomas nuo vietos, kur daugiausia vienetų; kaina — vadybininkės
// įrašyta, jei nėra — priedo kaina, jei ir jos nėra — įrašoma čia.
function CompleteShipModal({ task, onClose, onWriteoff, onCompleteOnly }) {
  const places = stockPlaces(task.part);
  const [amounts, setAmounts] = useState(() => {
    let left = task.quantity ?? 1;
    return Object.fromEntries(places.map((s) => {
      const take = Math.min(left, s.quantity);
      left -= take;
      return [s.id, String(take)];
    }));
  });
  const initialPrice = task.unit_price ?? task.part?.price;
  const [unitPrice, setUnitPrice] = useState(initialPrice != null ? String(initialPrice) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const lines = places.map((s) => ({ stock_id: s.id, quantity: Number(amounts[s.id] || 0) }));
  const totalQty = lines.reduce((sum, l) => sum + (Number.isInteger(l.quantity) ? l.quantity : 0), 0);
  const price = Number(unitPrice.trim().replace(",", "."));
  const priceValid = unitPrice.trim() !== "" && Number.isFinite(price) && price > 0;

  async function submit(e) {
    e.preventDefault();
    const bad = places.find((s) => {
      const q = Number(amounts[s.id] || 0);
      return !Number.isInteger(q) || q < 0 || q > s.quantity;
    });
    if (bad) {
      setError(`Vietoje ${bad.location} yra tik ${bad.quantity} vnt.`);
      return;
    }
    if (totalQty === 0) {
      setError("Nurodykite, iš kurios vietos nurašoma.");
      return;
    }
    if (!priceValid) {
      setError("Įveskite pardavimo kainą už vnt.");
      return;
    }
    setSaving(true);
    const errorMessage = await onWriteoff({ lines: lines.filter((l) => l.quantity > 0), unitPrice: price });
    setSaving(false);
    if (errorMessage) setError(errorMessage);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink-950/50 p-0 sm:items-center sm:p-4">
      <form
        onSubmit={submit}
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-panel sm:rounded-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">Atkrauta — nurašyti?</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-ink-900/5">
            <X size={18} />
          </button>
        </div>

        <p className="mb-3 text-sm text-ink-600/70">
          {task.part?.name || task.part?.part_code || "Priedas"} — užsakyta{" "}
          <span className="font-semibold text-ink-800">{task.quantity ?? 1} vnt.</span>
          {task.order_ref && ` · užs. ${task.order_ref}`}
        </p>

        <div className="space-y-3">
          {places.length === 0 ? (
            <p className="flex items-center gap-1.5 text-sm font-medium text-signal-red">
              <AlertCircle size={16} className="shrink-0" /> Likutyje nėra — nėra ko nurašyti.
            </p>
          ) : (
            <div>
              <p className="mb-1 text-xs font-semibold text-ink-600/70">Iš kur nurašoma</p>
              <ul className="space-y-1.5">
                {places.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2">
                    <span className="text-sm text-ink-800">
                      {s.warehouses?.name && `${s.warehouses.name} — `}
                      <span className="font-bold">{s.location}</span>
                      <span className="text-ink-600/60"> ({s.quantity} vnt.)</span>
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={s.quantity}
                      step={1}
                      value={amounts[s.id] ?? "0"}
                      onChange={(e) => setAmounts((prev) => ({ ...prev, [s.id]: e.target.value }))}
                      className="input-field w-20 py-1.5 text-sm"
                    />
                  </li>
                ))}
              </ul>
              {totalQty !== (task.quantity ?? 1) && (
                <p className="mt-1 text-xs font-medium text-signal-amber">
                  Nurašoma {totalQty} vnt., užsakyta {task.quantity ?? 1}.
                </p>
              )}
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pardavimo kaina už vnt.</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step="0.01"
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value)}
                placeholder="Įveskite"
                className="input-field w-32"
              />
              <span className="text-sm text-ink-600/50">€</span>
              {priceValid && totalQty > 1 && (
                <span className="text-xs text-ink-600/70">iš viso {(price * totalQty).toFixed(2)} €</span>
              )}
            </div>
            {task.unit_price == null && (
              <p className="mt-1 text-xs text-ink-600/60">
                Vadybininkė kainos neįrašė{task.part?.price != null ? " — pasiūlyta priedo kaina." : "."}
              </p>
            )}
          </div>

          {error && (
            <p className="flex items-center gap-1.5 text-sm font-medium text-signal-red">
              <AlertCircle size={16} className="shrink-0" /> {error}
            </p>
          )}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <button type="button" onClick={onCompleteOnly} className="text-xs font-semibold text-ink-600/60 underline hover:text-ink-800">
            Užbaigti be nurašymo
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="btn-secondary">
              Atšaukti
            </button>
            <button type="submit" disabled={saving || places.length === 0} className="btn-primary">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Nurašyti ir užbaigti
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

// Pranešimų (Web Push) įjungimas šiame įrenginyje — kiekviename kompiuteryje
// ar telefone įjungiama atskirai. Įjungus galima išsiųsti bandomąjį.
function PushToggle() {
  const [state, setState] = useState(null); // null = tikrinama
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    getPushState()
      .then((s) => {
        setState(s);
        if (s === "on") resyncPush().catch((err) => setMessage(`Prenumeratos įrašyti nepavyko: ${err.message}`));
      })
      .catch(() => setState("unsupported"));
  }, []);

  async function run(action) {
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (err) {
      setMessage(err.message === "denied" ? "Naršyklė užblokavo pranešimus." : `Nepavyko: ${err.message}`);
    }
    setState(await getPushState().catch(() => "unsupported"));
    setBusy(false);
  }

  async function test() {
    // Prieš bandymą — prenumerata dar kartą įrašoma į DB (jei jos ten nebuvo).
    await resyncPush();
    const { sent, subscriptions, errors } = await sendPush({ test: true });
    if (sent) setMessage(`Bandomasis pranešimas išsiųstas (įrenginių: ${sent}).`);
    else if (!subscriptions) setMessage("Serveris nerado nė vienos šio vartotojo prenumeratos.");
    else setMessage(`Pranešimų tarnyba atmetė (${subscriptions} prenum.): ${(errors || []).join("; ") || "nežinoma klaida"}`);
  }

  if (state === null) return null;

  if (state === "unsupported") {
    return needsHomeScreenInstall() ? (
      <p className="max-w-xs text-xs text-ink-600/60">
        Pranešimams iPhone: „Bendrinti“ → „Pridėti prie pradžios ekrano“ ir atidaryk programą iš ten.
      </p>
    ) : null;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap gap-1.5">
        {state === "on" ? (
          <>
            <span className="inline-flex items-center gap-1 self-center text-xs font-semibold text-signal-teal">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Bell size={14} />} Pranešimai įjungti
            </span>
            <button type="button" onClick={() => run(test)} disabled={busy} className="btn-secondary px-3 py-1.5 text-xs">
              Bandomasis
            </button>
            <button type="button" onClick={() => run(disablePush)} disabled={busy} className="btn-secondary px-3 py-1.5 text-xs">
              Išjungti
            </button>
          </>
        ) : state === "denied" ? (
          <span className="inline-flex items-center gap-1 text-xs text-ink-600/60">
            <BellOff size={14} /> Pranešimai užblokuoti naršyklės nustatymuose
          </span>
        ) : (
          <button type="button" onClick={() => run(enablePush)} disabled={busy} className="btn-secondary px-3 py-1.5 text-xs">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <BellOff size={14} />} Įjungti pranešimus
          </button>
        )}
      </div>
      {message && <p className="text-xs text-ink-600/70">{message}</p>}
    </div>
  );
}

export default function Tasks() {
  const { user, hasPermission } = useAuth();
  const canWriteoff = hasPermission("delete");
  const [completing, setCompleting] = useState(null); // išsiuntimo darbas, kurį užbaigiant nurašoma
  const [filter, setFilter] = useState(() => readPref("tasks.filter", "all"));
  // Rikiuoti pagal vietą — kad atkrautum viską vienu ėjimu per sandėlį.
  const [byPlace, setByPlace] = useState(() => readPref("tasks.byPlace", "0") === "1");
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
  const [names, setNames] = useState({}); // created_by -> vardas (kitų sukurtiems darbams)
  const inputRef = useRef(null);

  async function load() {
    const [openRes, doneRes] = await Promise.all([
      supabase.from("tasks").select(TASK_SELECT).eq("done", false).order("position", { ascending: true }),
      supabase.from("tasks").select(TASK_SELECT).eq("done", true)
        .order("done_at", { ascending: false })
        .limit(DONE_LIMIT)
    ]);
    if (openRes.error || doneRes.error) {
      setError(`Nepavyko įkelti darbų: ${(openRes.error || doneRes.error).message}`);
    } else {
      setOpenTasks(openRes.data);
      setDoneTasks(doneRes.data);
      setError("");
      loadNames([...openRes.data, ...doneRes.data]);
    }
    setLoading(false);
  }

  // Kas sukūrė man priskirtą darbą ("Nuo: …"). tasks.created_by rodo į
  // auth.users, ne profiles, todėl vardai pakraunami atskirai.
  async function loadNames(tasks) {
    const ids = [...new Set(tasks.map((t) => t.created_by).filter((id) => id !== user.id))];
    if (!ids.length) return;
    const { data } = await supabase.from("profiles").select("id, username").in("id", ids);
    setNames(Object.fromEntries((data || []).map((p) => [p.id, p.username])));
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

  const shipCount = openTasks.filter(isShipTask).length;
  const visibleOpen = openTasks.filter((t) => matchesFilter(t, filter));
  const visibleDone = doneTasks.filter((t) => matchesFilter(t, filter));

  // Pagal vietą: išsiuntimai grupės viršuje vietų tvarka ("8" prieš "42"),
  // po jų — kiti darbai įprasta tvarka. Tempti šiame režime negalima.
  const grouped = useMemo(() => {
    const map = { overdue: [], today: [], later: [], none: [] };
    const order = byPlace
      ? (a, b) => (isShipTask(b) - isShipTask(a)) || (isShipTask(a) ? byLocation(a, b) : byStarThenPosition(a, b))
      : byStarThenPosition;
    openTasks
      .filter((t) => matchesFilter(t, filter))
      .sort(order)
      .forEach((t) => map[groupOf(t, today)].push(t));
    return map;
  }, [openTasks, filter, today, byPlace]);

  function changeFilter(value) {
    setFilter(value);
    writePref("tasks.filter", value);
  }

  function toggleByPlace() {
    setByPlace((prev) => {
      writePref("tasks.byPlace", prev ? "0" : "1");
      return !prev;
    });
  }

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

  // Išsiuntimo darbas (susietas su priedu): užbaigiant siūloma nurašyti
  // kiekį, grąžinant į neatliktus — atšaukiami jo nurašymai.
  async function handleToggle(task) {
    if (!task.done && task.part_id && canWriteoff) {
      setCompleting(task);
      return;
    }
    const active = activeWriteoffs(task);
    if (task.done && active.length > 0) {
      const qty = active.reduce((sum, w) => sum + w.quantity, 0);
      if (!confirm(`Grąžinus darbą bus atšauktas nurašymas — ${qty} vnt. grįš į likutį. Tęsti?`)) return;
      const { error: rpcError } = await supabase.rpc("reopen_ship_task", { p_task_id: task.id });
      if (rpcError) setError(`Nepavyko grąžinti: ${rpcError.message}`);
      load();
      return;
    }
    setTaskDone(task, !task.done);
  }

  // Grąžina klaidos tekstą, jei nepavyko (CompleteShipModal jį rodo formoje).
  async function handleCompleteShip(task, { lines, unitPrice }) {
    const { error: rpcError } = await supabase.rpc("complete_ship_task", {
      p_task_id: task.id,
      p_lines: lines,
      p_unit_price: unitPrice
    });
    if (rpcError) return rpcError.message;
    setCompleting(null);
    load();
  }

  async function setTaskDone(task, done) {
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
        fromName={task.created_by !== user.id ? names[task.created_by] || "kolega" : null}
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Darbai</h1>
          <p className="mt-1 text-sm text-ink-600/70">Tavo darbų sąrašas — matai tik tu.</p>
        </div>
        <PushToggle />
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
          {(shipCount > 0 || filter !== "all") && (
            <div className="flex flex-wrap items-center gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => changeFilter(f.key)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                    filter === f.key
                      ? "border-ink-900 bg-ink-900 text-white"
                      : "border-ink-700/15 bg-white text-ink-700 hover:bg-ink-900/[0.03]"
                  }`}
                >
                  {f.label}
                  {f.key === "ship" && shipCount > 0 && <span className="ml-1 opacity-60">{shipCount}</span>}
                </button>
              ))}
              {filter !== "own" && shipCount > 1 && (
                <button
                  type="button"
                  onClick={toggleByPlace}
                  className={`ml-auto inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                    byPlace
                      ? "border-violet-500 bg-violet-500/10 text-violet-700"
                      : "border-ink-700/15 bg-white text-ink-700 hover:bg-ink-900/[0.03]"
                  }`}
                >
                  <MapPin size={13} /> Pagal vietą
                </button>
              )}
            </div>
          )}

          {visibleOpen.length === 0 && (
            <div className="panel flex flex-col items-center gap-2 py-10 text-center">
              <ListTodo className="text-ink-600/30" size={26} />
              <p className="text-sm text-ink-600/60">
                {filter === "ship" ? "Laukiančių išsiuntimų nėra." : "Neatliktų darbų nėra."}
              </p>
            </div>
          )}

          {GROUPS.filter((g) => grouped[g.key].length > 0).map((g) => (
            <section key={g.key}>
              <h2 className={`mb-1.5 px-1 text-xs font-bold uppercase tracking-wide ${g.tone}`}>
                {g.label} <span className="font-semibold text-ink-600/40">{grouped[g.key].length}</span>
              </h2>
              <SortableGroup tasks={grouped[g.key]} onReorder={patchTask}>
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {grouped[g.key].map((t) => renderCard(t, !byPlace))}
                </ul>
              </SortableGroup>
            </section>
          ))}

          {visibleDone.length > 0 && (
            <section>
              <button
                type="button"
                onClick={() => setShowDone((v) => !v)}
                className="mb-1.5 flex items-center gap-1 px-1 text-xs font-bold uppercase tracking-wide text-ink-600/60 hover:text-ink-700"
              >
                <ChevronDown size={14} className={`transition-transform ${showDone ? "" : "-rotate-90"}`} />
                Atlikti <span className="font-semibold text-ink-600/40">{visibleDone.length}{doneTasks.length >= DONE_LIMIT && "+"}</span>
              </button>
              {showDone && (
                <SortableGroup tasks={[]} onReorder={() => {}}>
                  <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {visibleDone.map((t) => renderCard(t, false))}
                  </ul>
                </SortableGroup>
              )}
            </section>
          )}
        </>
      )}

      {completing && (
        <CompleteShipModal
          task={completing}
          onClose={() => setCompleting(null)}
          onWriteoff={(form) => handleCompleteShip(completing, form)}
          onCompleteOnly={() => {
            const task = completing;
            setCompleting(null);
            setTaskDone(task, true);
          }}
        />
      )}
    </div>
  );
}
