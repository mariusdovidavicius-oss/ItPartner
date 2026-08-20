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

// Bendra nurašymo eilutės "detalė" (kaina/RMA/laisvas tekstas pagal
// priežastį) — tiek priedų, tiek prietaisų nurašymų sąrašuose identiška.
export function writeoffDetail(w) {
  if (w.reason_type === "parduota") return w.price != null ? `${w.price} €` : "—";
  if (w.reason_type === "remontui") return w.rma || "—";
  return w.reason || "—";
}
