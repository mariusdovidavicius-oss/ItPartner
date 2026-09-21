// Nurašymo priežasčių sąrašai — priedų ir prietaisų modulis dalinasi trimis
// bendromis priežastimis, prietaisai papildomai turi "garantija" (garantinis
// pakeitimas, kurio priedams nėra). Naudojama tiek pasirinkimo <select>
// (Parts.jsx/Devices.jsx WriteoffModal), tiek filtro/rodymo REASON_LABELS
// (PartsWriteoffs.jsx/DeviceWriteoffs.jsx) — anksčiau abu buvo atskirai
// kopijuojami į keturis failus.
export const PART_WRITEOFF_REASONS = [
  { value: "parduota", label: "Parduota" },
  { value: "remontui", label: "Panaudota remontui" },
  { value: "kita", label: "Kita" }
];

export const DEVICE_WRITEOFF_REASONS = [
  { value: "parduota", label: "Parduota" },
  { value: "remontui", label: "Panaudota remontui" },
  { value: "garantija", label: "Garantinis pakeitimas" },
  { value: "kita", label: "Kita" }
];

export function reasonLabelMap(reasons) {
  return Object.fromEntries(reasons.map((r) => [r.value, r.label]));
}

// Nurašymų sąrašo suvestinė (kiekis + parduota suma). Skaičiuojama TIK iš
// aktyvių (neatšauktų) eilučių — tą patį daro statistika (Stats.jsx), todėl
// suma sutampa su plytele. "price" yra VISA nurašymo suma, ne kaina už vienetą.
export function summarizeWriteoffs(rows) {
  let qty = 0;
  let revenue = 0;
  let soldCount = 0;
  rows.forEach((w) => {
    qty += w.quantity || 0;
    if (w.reason_type === "parduota" && w.price != null) {
      revenue += Number(w.price);
      soldCount += 1;
    }
  });
  return { count: rows.length, qty, revenue, soldCount };
}

// Bendra nurašymo eilutės "detalė" (kaina/RMA/laisvas tekstas pagal
// priežastį) — tiek priedų, tiek prietaisų nurašymų sąrašuose identiška.
export function writeoffDetail(w) {
  if (w.reason_type === "parduota") return w.price != null ? `${w.price} €` : "—";
  if (w.reason_type === "remontui") return w.rma || "—";
  return w.reason || "—";
}
