// Bendras laikotarpio filtras — naudojamas /statistika (Stats.jsx) ir nurašymų
// sąrašuose (PartsWriteoffs.jsx / DeviceWriteoffs.jsx), kad plytelės
// statistikoje ir po paspaudimo atsidariusi lentelė skaičiuotų tą patį
// laikotarpį.
//
// Būsena — objektas { period, from, to }: "period" — paruoštas laikotarpis
// arba "custom" (pasirinktinai), "from"/"to" — datos "YYYY-MM-DD" (naudojamos
// tik su "custom"; kuri nors gali būti tuščia = riba neribojama).
//
// URL: paruošti laikotarpiai — ?laikotarpis=30d|month|lastmonth|ytd (visada —
// be parametro), pasirinktinai — ?nuo=YYYY-MM-DD&iki=YYYY-MM-DD.
//
// Užklausoms paverčiama į intervalą [from, to): "from" įskaitytinai, "to" NE
// (kitos dienos pradžia), todėl pasirinkta "iki" diena įtraukiama visa.
// Dienos ribos skaičiuojamos pagal naršyklės laiko juostą.
export const PERIOD_OPTIONS = [
  { value: "30d", label: "Paskutinės 30 d." },
  { value: "month", label: "Šis mėnuo" },
  { value: "lastmonth", label: "Praėjęs mėnuo" },
  { value: "ytd", label: "Šie metai" },
  { value: "all", label: "Visada" },
  { value: "custom", label: "Pasirinktinai…" }
];

const PRESETS = PERIOD_OPTIONS.map((o) => o.value).filter((v) => v !== "custom");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// "YYYY-MM-DD" → vietinė to ryto pradžia arba null, jei tai ne tikra data
// (pvz. "2026-13-45" arba "2026-02-30" atmetama, nes JS jas "perkeltų").
export function parseDateStr(str) {
  if (typeof str !== "string" || !DATE_RE.test(str)) return null;
  const [y, m, d] = str.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

export function formatDateStr(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Grąžina { from, to } — ISO laikai arba null (neribojama). "to" — išskirtinė riba.
export function periodRange(state, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (state.period) {
    case "30d": {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return { from: d.toISOString(), to: null };
    }
    case "month":
      return { from: new Date(y, m, 1).toISOString(), to: null };
    case "lastmonth":
      return { from: new Date(y, m - 1, 1).toISOString(), to: new Date(y, m, 1).toISOString() };
    case "ytd":
      return { from: new Date(y, 0, 1).toISOString(), to: null };
    case "custom": {
      let from = parseDateStr(state.from);
      let to = parseDateStr(state.to);
      if (from && to && from > to) [from, to] = [to, from]; // sukeistos datos — taisome, o ne rodome tuščia
      return {
        from: from ? from.toISOString() : null,
        to: to ? new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).toISOString() : null
      };
    }
    default:
      return { from: null, to: null };
  }
}

// Stabilus raktas useEffect/useLiveQuery priklausomybėms.
export function periodKey(state) {
  return state.period === "custom" ? `custom|${state.from}|${state.to}` : state.period;
}

// Žmogui suprantamas pavadinimas (antraštėms).
export function periodLabel(state) {
  if (state.period !== "custom") return PERIOD_OPTIONS.find((o) => o.value === state.period)?.label ?? "Visada";
  const from = parseDateStr(state.from) ? state.from : "";
  const to = parseDateStr(state.to) ? state.to : "";
  if (from && to) return `${from} – ${to}`;
  if (from) return `nuo ${from}`;
  if (to) return `iki ${to}`;
  return "Visada";
}

// Įrašo laikotarpį į URL parametrus (nuorodoms iš statistikos plytelių).
export function periodToParams(state, params = new URLSearchParams()) {
  if (state.period === "custom") {
    if (parseDateStr(state.from)) params.set("nuo", state.from);
    if (parseDateStr(state.to)) params.set("iki", state.to);
  } else if (state.period !== "all") {
    params.set("laikotarpis", state.period);
  }
  return params;
}

// Pradinė būsena iš URL (skaitoma vieną kartą). Neteisingos reikšmės ignoruojamos.
export function periodStateFromParams(params, fallback = "all") {
  const from = params.get("nuo");
  const to = params.get("iki");
  if (parseDateStr(from) || parseDateStr(to)) {
    return { period: "custom", from: parseDateStr(from) ? from : "", to: parseDateStr(to) ? to : "" };
  }
  const p = params.get("laikotarpis");
  if (PRESETS.includes(p)) return { period: p, from: "", to: "" };
  return { period: fallback, from: "", to: "" };
}

// Perjungiant į "Pasirinktinai" datos užpildomos iš to, ką vartotojas ką tik matė
// (pvz. "Praėjęs mėnuo" → to mėnesio pirma ir paskutinė diena), o ne paliekamos tuščios.
export function customFromState(state, now = new Date()) {
  const { from, to } = periodRange(state, now);
  return {
    period: "custom",
    from: from ? formatDateStr(new Date(from)) : "",
    to: to ? formatDateStr(new Date(new Date(to).getTime() - 1)) : ""
  };
}
