// Vienintelis šaltinis priedų modulio teisėms JS/API pusėje — naudojamas
// tiek frontend'e (PartsUsers.jsx), tiek api/create-user.js serverless
// funkcijoje. DB pusėje (supabase/migrate_add_parts_permissions.sql)
// tas pats sąrašas įtvirtintas atskirai per SQL "check" apribojimą, nes
// duomenų bazė šio failo importuoti negali — keičiant sąrašą, atnaujinti
// abu.
export const PERMISSIONS = [
  { key: "view", label: "Peržiūrėti" },
  { key: "edit", label: "Redaguoti" },
  { key: "delete", label: "Trinti" },
  { key: "import", label: "Importas" }
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
