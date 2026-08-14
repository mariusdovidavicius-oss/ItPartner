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

// Paletžų/siuntų modulio teisės — atskiros nuo aukščiau esančių priedų
// teisių (žr. supabase/migrate_add_pallet_permissions.sql). Naudojamas tiek
// frontend'e (PartsUsers.jsx, AuthProvider.jsx), tiek api/create-user.js.
export const PALLET_PERMISSIONS = [
  { key: "scan", label: "Skenavimas" },
  { key: "ship", label: "Siuntos" }
];

export const PALLET_PERMISSION_KEYS = PALLET_PERMISSIONS.map((p) => p.key);
