import { requireAdminCaller } from "../src/lib/adminAuth.js";

// Vercel serverless funkcija — vartotojo trynimas (Supabase Auth admin API).
// profiles.id -> auth.users(id) on delete cascade, o user_permissions/
// pallet_permissions/device_permissions -> profiles(id) on delete cascade,
// tad užtenka ištrinti auth.users įrašą — likusios lentelės išsivalo pačios.
// Nurašymų/atsinešimų įrašuose user_id yra "on delete set null" — istorija
// išlieka, tik nebesusieta su konkrečiu (jau ištrintu) vartotoju.
// Kviečiantis turi būti prisijungęs adminas ir negali ištrinti savęs.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { supabaseAdmin, error: authError } = await requireAdminCaller(req);
  if (authError) {
    res.status(authError.status).json({ error: authError.message });
    return;
  }

  const { userId } = req.body || {};
  if (!userId) {
    res.status(400).json({ error: "Trūksta vartotojo ID." });
    return;
  }

  const { data: callerData } = await supabaseAdmin.auth.getUser(
    req.headers.authorization.slice(7)
  );
  if (callerData?.user?.id === userId) {
    res.status(400).json({ error: "Negalite ištrinti savo paties paskyros." });
    return;
  }

  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  res.status(200).json({ ok: true });
}
