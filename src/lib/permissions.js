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

// Prietaisų (įrangos) modulio teisės — atskiros IR nuo priedų (user_permissions),
// IR nuo paletžų (pallet_permissions) teisių (žr. supabase/migrate_add_devices.sql).
// Skirtingai nuo abiejų aukščiau — "view" čia realiai riboja ir SELECT (peržiūra
// šiame modulyje NĖRA vieša). Naudojamas tiek frontend'e (PartsUsers.jsx,
// AuthProvider.jsx), tiek api/create-user.js.
export const DEVICE_PERMISSIONS = [
  { key: "view", label: "Peržiūrėti" },
  { key: "edit", label: "Redaguoti" },
  { key: "delete", label: "Trinti" },
  { key: "import", label: "Importas" }
];

export const DEVICE_PERMISSION_KEYS = DEVICE_PERMISSIONS.map((p) => p.key);
