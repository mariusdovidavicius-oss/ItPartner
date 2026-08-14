import { createClient } from "@supabase/supabase-js";
import { PERMISSION_KEYS, PALLET_PERMISSION_KEYS } from "../src/lib/permissions.js";
import { AUTH_EMAIL_DOMAIN } from "../src/lib/authConstants.js";

// Vercel serverless funkcija — vienintelė vieta, kur naudojamas Supabase
// service_role raktas (SUPABASE_SERVICE_ROLE_KEY aplinkos kintamasis,
// BE "VITE_" priešdėlio, kad Vite jo neįtrauktų į naršyklės bundle'ą).
// Kviečiantis turi būti prisijungęs adminas — tikrinama pagal jo access
// token'ą prieš kuriant naują vartotoją.

function adminClient() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "Trūksta prisijungimo žymens." });
    return;
  }

  const supabaseAdmin = adminClient();

  const { data: callerData, error: callerError } = await supabaseAdmin.auth.getUser(token);
  if (callerError || !callerData?.user) {
    res.status(401).json({ error: "Neteisingas arba pasibaigęs prisijungimas." });
    return;
  }

  const { data: callerProfile } = await supabaseAdmin
    .from("profiles")
    .select("is_admin")
    .eq("id", callerData.user.id)
    .maybeSingle();

  if (!callerProfile?.is_admin) {
    res.status(403).json({ error: "Tik administratorius gali kurti vartotojus." });
    return;
  }

  const { id, password, permissions = [], palletPermissions = [], isAdmin = false } = req.body || {};

  const cleanId = String(id || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,32}$/.test(cleanId)) {
    res.status(400).json({ error: "ID gali būti tik raidės/skaičiai/._- (2-32 simboliai)." });
    return;
  }
  if (!password || String(password).length < 6) {
    res.status(400).json({ error: "Slaptažodis turi būti bent 6 simbolių." });
    return;
  }
  const cleanPermissions = (Array.isArray(permissions) ? permissions : []).filter((p) =>
    PERMISSION_KEYS.includes(p)
  );
  const cleanPalletPermissions = (Array.isArray(palletPermissions) ? palletPermissions : []).filter((p) =>
    PALLET_PERMISSION_KEYS.includes(p)
  );

  const email = `${cleanId}@${AUTH_EMAIL_DOMAIN}`;

  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: String(password),
    email_confirm: true
  });

  if (createError) {
    const message = createError.message?.includes("already been registered")
      ? "Toks ID jau užimtas."
      : createError.message;
    res.status(400).json({ error: message });
    return;
  }

  const newUserId = created.user.id;

  if (isAdmin) {
    const { error } = await supabaseAdmin.from("profiles").update({ is_admin: true }).eq("id", newUserId);
    if (error) {
      await supabaseAdmin.auth.admin.deleteUser(newUserId);
      res.status(500).json({ error: `Vartotojas sukurtas, bet nepavyko priskirti admin teisės: ${error.message}` });
      return;
    }
  }

  if (cleanPermissions.length > 0) {
    const { error } = await supabaseAdmin
      .from("user_permissions")
      .insert(cleanPermissions.map((permission) => ({ user_id: newUserId, permission })));
    if (error) {
      await supabaseAdmin.auth.admin.deleteUser(newUserId);
      res.status(500).json({ error: `Vartotojas sukurtas, bet nepavyko priskirti teisių: ${error.message}` });
      return;
    }
  }

  if (cleanPalletPermissions.length > 0) {
    const { error } = await supabaseAdmin
      .from("pallet_permissions")
      .insert(cleanPalletPermissions.map((permission) => ({ user_id: newUserId, permission })));
    if (error) {
      await supabaseAdmin.auth.admin.deleteUser(newUserId);
      res.status(500).json({ error: `Vartotojas sukurtas, bet nepavyko priskirti paletžų teisių: ${error.message}` });
      return;
    }
  }

  res.status(200).json({ ok: true, id: newUserId, username: cleanId });
}
