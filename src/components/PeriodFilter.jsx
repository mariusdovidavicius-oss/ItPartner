import { PERIOD_OPTIONS, customFromState } from "../lib/period";

// Laikotarpio valdiklis: paruošti laikotarpiai + "Pasirinktinai…", kuris
// parodo du datos laukus (nuo / iki; kuris nors gali likti tuščias =
// neribojama). Naudojamas /statistika ir nurašymų sąrašuose; būsenos forma ir
// logika — lib/period.js.
export default function PeriodFilter({ value, onChange }) {
  function handleSelect(e) {
    const next = e.target.value;
    // Į "Pasirinktinai" pereinant datos užpildomos iš to, ką vartotojas ką tik matė
    onChange(next === "custom" ? customFromState(value) : { period: next, from: "", to: "" });
  }

  const dateInput = "input-field w-auto py-1.5 text-sm";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-ink-600/70">
        Laikotarpis
        <select value={value.period} onChange={handleSelect} className="input-field w-auto py-1.5 text-sm">
          {PERIOD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>

      {value.period === "custom" && (
        <>
          <label className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-ink-600/70">
            Nuo
            <input
              type="date"
              value={value.from}
              max={value.to || undefined}
              onChange={(e) => onChange({ ...value, from: e.target.value })}
              className={dateInput}
            />
          </label>
          <label className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-ink-600/70">
            Iki
            <input
              type="date"
              value={value.to}
              min={value.from || undefined}
              onChange={(e) => onChange({ ...value, to: e.target.value })}
              className={dateInput}
            />
          </label>
        </>
      )}
    </div>
  );
}
