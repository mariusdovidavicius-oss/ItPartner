// Bendros pagalbinės funkcijos, anksčiau kopijuotos į kiekvieną puslapį,
// kuriam jų reikėjo (paieška, datos rodymas) — pačios funkcijos visur buvo
// identiškos, todėl sukelta į vieną vietą.

// Apsaugo nuo netyčinio ILIKE wildcard elgesio, jei paieškos tekste yra % arba _.
export function escapeLike(str) {
  return str.replace(/[%_]/g, (c) => `\\${c}`);
}

export function formatDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("lt-LT");
}

export function formatDateTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("lt-LT");
}
