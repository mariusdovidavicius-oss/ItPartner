import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Search, Loader2, Save, Boxes, Minus, Plus, ChevronLeft, ChevronRight,
  ChevronDown, ChevronUp, ImageIcon, Pencil, X
} from "lucide-react";
import { supabase } from "../lib/supabaseClient";

function normalize(str) {
  return String(str ?? "").toLowerCase();
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export default function Parts() {
  const [parts, setParts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [quantityDrafts, setQuantityDrafts] = useState({}); // part id -> juodraštis (nekeičiamas realtime reload metu, kad neišsivalytų nebaigtas redagavimas)
  const [savingId, setSavingId] = useState(null);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState(new Set()); // part id -> eilutė išskleista (foto vieta, pilnas suderinamų modelių tekstas, pastaba, redagavimas)
  const [notesDrafts, setNotesDrafts] = useState({}); // part id -> pastabos juodraštis
  const [savingNotesId, setSavingNotesId] = useState(null);
  const [editingPart, setEditingPart] = useState(null);

  useEffect(() => {
    load();
    const channel = supabase
      .channel("parts-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "parts" }, load)
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from("parts")
      .select("id, location, main_model, part_code, name, quantity, online_store, compatible_models, notes")
      .order("location", { ascending: true });

    const list = data || [];
    setParts(list);

    setQuantityDrafts((prev) => {
      const next = {};
      list.forEach((p) => {
        next[p.id] = p.id in prev ? prev[p.id] : String(p.quantity ?? 0);
      });
      return next;
    });

    setNotesDrafts((prev) => {
      const next = {};
      list.forEach((p) => {
        next[p.id] = p.id in prev ? prev[p.id] : (p.notes || "");
      });
      return next;
    });

    setLoading(false);
  }

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return parts;
    return parts.filter((p) =>
      normalize(p.part_code).includes(term) ||
      normalize(p.name).includes(term) ||
      normalize(p.main_model).includes(term) ||
      normalize(p.compatible_models).includes(term)
    );
  }, [parts, search]);

  // Puslapiavimas grįžta į pradžią, kai pasikeičia paieška arba puslapio dydis —
  // priešingu atveju likus dabartiniam page indeksui, po siauresnės paieškos
  // galima "iškristi" už rezultatų ribų (tuščias puslapis).
  useEffect(() => {
    setPage(0);
  }, [search, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const paginated = useMemo(
    () => filtered.slice(currentPage * pageSize, currentPage * pageSize + pageSize),
    [filtered, currentPage, pageSize]
  );

  function toggleExpand(id) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSaveQuantity(part) {
    const raw = quantityDrafts[part.id] ?? "";
    const value = Math.max(0, Math.round(Number(raw)) || 0);
    setSavingId(part.id);
    await supabase.from("parts").update({ quantity: value }).eq("id", part.id);
    setSavingId(null);
  }

  // Greitas +/− vieno vieneto paėmimui/pridėjimui — pritaiko prie DABAR
  // rodomos (draft) reikšmės ir iškart išsaugo, be atskiro "Išsaugoti"
  // paspaudimo. Skaičiaus laukas + "Išsaugoti" lieka masinei korekcijai.
  async function handleStep(part, delta) {
    if (savingId === part.id) return;
    const base = Math.round(Number(quantityDrafts[part.id])) || 0;
    const value = Math.max(0, base + delta);
    setSavingId(part.id);
    await supabase.from("parts").update({ quantity: value }).eq("id", part.id);
    setQuantityDrafts((prev) => ({ ...prev, [part.id]: String(value) }));
    setSavingId(null);
  }

  async function handleSaveNotes(part) {
    setSavingNotesId(part.id);
    const value = notesDrafts[part.id] || "";
    await supabase.from("parts").update({ notes: value.trim() || null }).eq("id", part.id);
    setSavingNotesId(null);
  }

  async function handleSaveEdit(partId, form) {
    await supabase
      .from("parts")
      .update({
        main_model: form.main_model.trim() || null,
        name: form.name.trim() || null,
        part_code: form.part_code.trim(),
        location: Math.round(Number(form.location)) || 0,
        compatible_models: form.compatible_models.trim() || null,
        online_store: form.online_store
      })
      .eq("id", partId);
    setEditingPart(null);
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink-900 lg:text-2xl">Priedai</h1>
        <p className="mt-1 text-sm text-ink-600/70">
          Priedų (atsarginių dalių) sandėlio paieška ir kiekio redagavimas.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-600/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Ieškoti pagal kodą, pavadinimą, modelį arba suderinamą modelį…"
            autoComplete="off"
            className="input-field pl-10"
          />
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-ink-600/70">
          Rodyti po
          <select
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            className="input-field w-auto py-1.5 text-sm"
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="panel overflow-hidden p-0">
        {loading ? (
          <div className="flex justify-center py-10 text-ink-600/50">
            <Loader2 className="animate-spin" size={20} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Boxes className="text-ink-600/30" size={24} />
            <p className="text-sm text-ink-600/60">
              {parts.length === 0 ? "Priedų dar nėra — importuokite juos per /priedai/importas." : "Pagal paiešką nieko nerasta."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-ink-900/5 bg-ink-900/[0.02] text-xs uppercase tracking-wide text-ink-600/60">
                <tr>
                  <th className="w-8 px-2 py-2.5"></th>
                  <th className="px-3 py-2.5 font-semibold">Modelis</th>
                  <th className="px-3 py-2.5 font-semibold">Pavadinimas</th>
                  <th className="px-3 py-2.5 font-semibold">Kodas</th>
                  <th className="px-3 py-2.5 font-semibold">Kiekis</th>
                  <th className="px-3 py-2.5 font-semibold">El. p-vė</th>
                  <th className="px-3 py-2.5 font-semibold">Lok.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-900/5">
                {paginated.map((p) => {
                  const draft = quantityDrafts[p.id] ?? "";
                  const changed = draft !== String(p.quantity ?? 0);
                  const expanded = expandedIds.has(p.id);
                  const notesDraft = notesDrafts[p.id] ?? "";
                  return (
                    <Fragment key={p.id}>
                      <tr className={expanded ? "bg-ink-900/[0.015]" : "hover:bg-ink-900/[0.015]"}>
                        <td className="px-2 py-2.5">
                          <button
                            type="button"
                            onClick={() => toggleExpand(p.id)}
                            className="rounded-lg p-1 text-ink-600/50 hover:bg-ink-900/5 hover:text-ink-900"
                            aria-label="Peržiūrėti daugiau"
                          >
                            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                          </button>
                        </td>
                        <td className="max-w-[140px] truncate px-3 py-2.5 text-ink-800">{p.main_model || "—"}</td>
                        <td className="max-w-[160px] truncate px-3 py-2.5 text-ink-800">{p.name || "—"}</td>
                        <td className="max-w-[110px] truncate px-3 py-2.5 font-mono text-ink-900">{p.part_code}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleStep(p, -1)}
                              disabled={savingId === p.id || Number(draft) <= 0}
                              className="btn-secondary shrink-0 px-1.5 py-1"
                              aria-label="Sumažinti 1 vnt."
                            >
                              <Minus size={13} />
                            </button>
                            <input
                              type="number"
                              min={0}
                              value={draft}
                              onChange={(e) =>
                                setQuantityDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                              }
                              className="input-field w-16 shrink-0 py-1 text-center text-xs [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            />
                            <button
                              type="button"
                              onClick={() => handleStep(p, 1)}
                              disabled={savingId === p.id}
                              className="btn-secondary shrink-0 px-1.5 py-1"
                              aria-label="Padidinti 1 vnt."
                            >
                              <Plus size={13} />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSaveQuantity(p)}
                              disabled={!changed || savingId === p.id}
                              className="btn-secondary shrink-0 px-1.5 py-1"
                              aria-label="Išsaugoti kiekį"
                            >
                              {savingId === p.id ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                            </button>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <span
                            className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                              p.online_store
                                ? "border-signal-teal/30 bg-signal-teal/10 text-signal-teal"
                                : "border-ink-700/15 bg-ink-900/[0.03] text-ink-600/60"
                            }`}
                          >
                            {p.online_store ? "Taip" : "Ne"}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 font-bold text-ink-900">{p.location}</td>
                      </tr>

                      {expanded && (
                        <tr className="bg-ink-900/[0.015]">
                          <td colSpan={7} className="px-4 py-4">
                            <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
                              <div className="flex h-28 w-full flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-ink-700/15 text-ink-600/40 sm:w-40">
                                <ImageIcon size={22} />
                                <span className="text-[11px]">Nuotrauka (netrukus)</span>
                              </div>

                              <div className="space-y-3">
                                <div>
                                  <p className="mb-1 text-xs font-semibold text-ink-600/70">Suderinami modeliai</p>
                                  <p className="text-sm text-ink-800">{p.compatible_models || "—"}</p>
                                </div>

                                <div>
                                  <p className="mb-1 text-xs font-semibold text-ink-600/70">Pastaba</p>
                                  <div className="flex items-start gap-2">
                                    <textarea
                                      value={notesDraft}
                                      onChange={(e) =>
                                        setNotesDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                                      }
                                      rows={2}
                                      placeholder="Pastaba apie priedą (nebūtina)"
                                      className="input-field flex-1 resize-none py-2 text-sm"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => handleSaveNotes(p)}
                                      disabled={
                                        savingNotesId === p.id || notesDraft === (p.notes || "")
                                      }
                                      className="btn-secondary shrink-0 px-2.5 py-2"
                                      aria-label="Išsaugoti pastabą"
                                    >
                                      {savingNotesId === p.id
                                        ? <Loader2 size={14} className="animate-spin" />
                                        : <Save size={14} />}
                                    </button>
                                  </div>
                                </div>

                                <button
                                  type="button"
                                  onClick={() => setEditingPart(p)}
                                  className="btn-secondary"
                                >
                                  <Pencil size={14} /> Redaguoti
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!loading && filtered.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-ink-600/50">
            Rodoma {currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, filtered.length)} iš{" "}
            {filtered.length}
            {filtered.length !== parts.length && ` (iš viso ${parts.length})`}
          </p>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={currentPage === 0}
                className="btn-secondary px-2.5 py-1.5"
                aria-label="Ankstesnis puslapis"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="text-xs font-medium text-ink-600/70">
                {currentPage + 1} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={currentPage >= totalPages - 1}
                className="btn-secondary px-2.5 py-1.5"
                aria-label="Kitas puslapis"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      )}

      {editingPart && (
        <EditPartModal
          part={editingPart}
          onClose={() => setEditingPart(null)}
          onSave={handleSaveEdit}
        />
      )}
    </div>
  );
}

function EditPartModal({ part, onClose, onSave }) {
  const [form, setForm] = useState({
    main_model: part.main_model || "",
    name: part.name || "",
    part_code: part.part_code || "",
    location: part.location ?? 0,
    compatible_models: part.compatible_models || "",
    online_store: !!part.online_store
  });
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    await onSave(part.id, form);
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink-950/50 p-0 sm:items-center sm:p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-panel sm:rounded-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">Redaguoti priedą</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-ink-900/5">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pagrindinis modelis</label>
            <input
              value={form.main_model}
              onChange={(e) => setForm({ ...form, main_model: e.target.value })}
              className="input-field"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Pavadinimas</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="input-field"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Detalės kodas</label>
            <input
              value={form.part_code}
              onChange={(e) => setForm({ ...form, part_code: e.target.value })}
              className="input-field font-mono"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Lokacija</label>
            <input
              type="number"
              min={0}
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              className="input-field"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-600/70">Suderinami modeliai</label>
            <textarea
              value={form.compatible_models}
              onChange={(e) => setForm({ ...form, compatible_models: e.target.value })}
              rows={2}
              className="input-field resize-none"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={form.online_store}
              onChange={(e) => setForm({ ...form, online_store: e.target.checked })}
              className="h-4 w-4 rounded border-ink-700/30 text-signal-orange focus:ring-signal-orange/30"
            />
            Parduodama el. parduotuvėje
          </label>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Atšaukti
          </button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving && <Loader2 size={15} className="animate-spin" />}
            Išsaugoti
          </button>
        </div>
      </form>
    </div>
  );
}
