export const UNCLASSIFIED = "unclassified";

function normalizePart(str) {
  return String(str ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

// "Grizzly" + "Prietaisai" -> "grizzly_prietaisai"; trūkstant bet kurio lauko -> "unclassified"
export function computeDestination(manufacturer, itemType) {
  const m = normalizePart(manufacturer);
  const t = normalizePart(itemType);
  if (!m || !t) return UNCLASSIFIED;
  return `${m}_${t}`;
}

// "grizzly_prietaisai" -> "Grizzly - Prietaisai"; "unclassified" -> "Nepriskirta"
export function prettifyDestination(destination) {
  if (!destination || destination === UNCLASSIFIED) return "Nepriskirta";
  return destination
    .split("_")
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" - ");
}
