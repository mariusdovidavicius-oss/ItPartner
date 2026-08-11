// Vienintelis šaltinis "ID → vidinis el. paštas" konvertavimui — naudojamas
// AuthProvider.jsx (prisijungimas), api/create-user.js ir
// scripts/bootstrap-admin.mjs (vartotojo kūrimas). Keičiant domeną,
// pakanka pakeisti čia.
export const AUTH_EMAIL_DOMAIN = "parts.local";

export function idToEmail(id) {
  return `${String(id).trim().toLowerCase()}@${AUTH_EMAIL_DOMAIN}`;
}
