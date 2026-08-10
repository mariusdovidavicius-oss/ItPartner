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

// "grizzly_prietaisai" -> { manufacturer: "Grizzly", itemType: "Prietaisai" }
export function splitDestination(destination) {
  if (!destination || destination === UNCLASSIFIED) return { manufacturer: "Nepriskirta", itemType: "—" };
  const idx = destination.indexOf("_");
  if (idx === -1) return { manufacturer: destination, itemType: "—" };
  const m = destination.slice(0, idx);
  const t = destination.slice(idx + 1);
  return {
    manufacturer: m ? m.charAt(0).toUpperCase() + m.slice(1) : m,
    itemType: t ? t.charAt(0).toUpperCase() + t.slice(1) : t,
  };
}
