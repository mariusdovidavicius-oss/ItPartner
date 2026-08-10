// Įrankio (prietaiso) būsenos gyvavimo ciklas
export const ITEM_STATUSES = [
  { value: "registered", label: "Užregistruota", color: "blue" },
  { value: "checked", label: "Patikrinta", color: "amber" },
  { value: "packed", label: "Supakuota į paletę", color: "teal" },
  { value: "shipped", label: "Išsiųsta", color: "ink" },
  { value: "rejected", label: "Atmesta", color: "red" }
];

// Siuntos būsenos
export const SHIPMENT_STATUSES = [
  { value: "open",  label: "Aktyvi",    color: "amber" },
  { value: "sent",  label: "Išsiųsta",  color: "teal"  }
];

// Paletės / siuntos būsenos
export const PALLET_STATUSES = [
  { value: "open", label: "Formuojama", color: "amber" },
  { value: "closed", label: "Uždaryta", color: "blue" },
  { value: "ready", label: "Paruošta išvežimui", color: "teal" },
  { value: "shipped", label: "Išsiųsta", color: "ink" },
  { value: "delivered", label: "Pristatyta", color: "ink" }
];

export const STATUS_COLOR_CLASSES = {
  blue: "bg-signal-blue/10 text-signal-blue border-signal-blue/20",
  amber: "bg-signal-amber/15 text-[#8a5b10] border-signal-amber/30",
  teal: "bg-signal-teal/10 text-signal-teal border-signal-teal/20",
  red: "bg-signal-red/10 text-signal-red border-signal-red/20",
  ink: "bg-ink-900/5 text-ink-800 border-ink-900/10"
};

export function statusMeta(list, value) {
  return list.find((s) => s.value === value) || list[0];
}
