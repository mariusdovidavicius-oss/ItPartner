// Trim + mažosios raidės + diakritikų pašalinimas — antraštės atpažinimui
// nepriklausomai nuo koduotės/rašybos variacijų (pvz. jei eksportas sugadina raides).
export function normalizeHeader(str) {
  return String(str ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
}

// Stulpelio indeksas (0-based) -> Excel raidė (A, B, ..., Z, AA, AB, ...).
// Naudojama visuose trijuose importo tipuose (priedai/prietaisai/katalogas)
// stulpelių pasirinkimo <select> parinktims žymėti.
export function columnLabel(index) {
  let n = index;
  let label = "";
  do {
    label = String.fromCharCode((n % 26) + 65) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}
