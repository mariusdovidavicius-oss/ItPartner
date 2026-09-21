// Bendras laikotarpio filtras — naudojamas /statistika (Stats.jsx) ir nurašymų
// sąrašuose (PartsWriteoffs.jsx / DeviceWriteoffs.jsx), kad plytelės
// statistikoje ir po paspaudimo atsidariusi lentelė skaičiuotų tą patį
// laikotarpį. Reikšmės eina per URL kaip ?laikotarpis=30d|ytd (visada — be
// parametro).
export const PERIOD_OPTIONS = [
  { value: "30d", label: "Paskutinės 30 d." },
  { value: "ytd", label: "Šie metai" },
  { value: "all", label: "Visada" }
];

export function isPeriod(value) {
  return PERIOD_OPTIONS.some((o) => o.value === value);
}

export function periodStart(period) {
  const now = new Date();
  if (period === "30d") {
    const d = new Date(now);
    d.setDate(d.getDate() - 30);
    return d.toISOString();
  }
  if (period === "ytd") return new Date(now.getFullYear(), 0, 1).toISOString();
  return null;
}
