// Bendros pagalbinės funkcijos, anksčiau kopijuotos į kiekvieną puslapį,
// kuriam jų reikėjo (paieška, datos rodymas) — pačios funkcijos visur buvo
// identiškos, todėl sukelta į vieną vietą.

// Apsaugo nuo netyčinio ILIKE wildcard elgesio, jei paieškos tekste yra % arba _.
export function escapeLike(str) {
  return str.replace(/[%_]/g, (c) => `\\${c}`);
}

// Paieškos teksto "sulankstymas" — mažosios raidės + LT raidės be diakritikų
// ("Šepetys" -> "sepetys"). TURI atitikti public.lt_fold() DB pusėje
// (supabase/migrate_search_lt_fold.sql), nes ieškoma per search_text stulpelį,
// sugeneruotą ta pačia funkcija.
const LT_FOLD = { ą: "a", č: "c", ę: "e", ė: "e", į: "i", š: "s", ų: "u", ū: "u", ž: "z" };
export function foldLt(str) {
  return str.toLowerCase().replace(/[ąčęėįšųūž]/g, (c) => LT_FOLD[c]);
}

// Paieškos žodis, paruoštas "search_text ILIKE %…%" filtrui.
export function searchPattern(token) {
  return `%${escapeLike(foldLt(token))}%`;
}

export function formatDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("lt-LT");
}

export function formatDateTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("lt-LT");
}
