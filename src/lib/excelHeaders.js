// Trim + mažosios raidės + diakritikų pašalinimas — antraštės atpažinimui
// nepriklausomai nuo koduotės/rašybos variacijų (pvz. jei eksportas sugadina raides).
export function normalizeHeader(str) {
  return String(str ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
}
