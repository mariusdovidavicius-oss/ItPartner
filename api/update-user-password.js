import { requireAdminCaller } from "../src/lib/adminAuth.js";

// Vercel serverless funkcija — vienintelis būdas pakeisti kito vartotojo
// slaptažodį (Supabase Auth admin API, reikalauja service_role rakto).
// Kviečiantis turi būti prisijungęs adminas.

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

  const { userId, password } = req.body || {};
  if (!userId) {
    res.status(400).json({ error: "Trūksta vartotojo ID." });
    return;
  }
  if (!password || String(password).length < 6) {
    res.status(400).json({ error: "Slaptažodis turi būti bent 6 simbolių." });
    return;
  }

  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password: String(password) });
  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  res.status(200).json({ ok: true });
}
