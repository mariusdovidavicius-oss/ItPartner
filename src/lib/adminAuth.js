import { createClient } from "@supabase/supabase-js";

// TIK serverio pusei (api/*.js) — naudoja process.env (Node), o ne
// import.meta.env (Vite/naršyklė). NIEKADA neimportuoti iš src/pages/ ar
// src/components/, kitaip Vite bandys tai įtraukti į naršyklės bundle'ą.
//
// Bendra dalis abiem /api funkcijoms (create-user, update-user-password) —
// service_role klientas ir kviečiančiojo admin patikrinimas pagal jo access
// token'ą. SUPABASE_SERVICE_ROLE_KEY aplinkos kintamasis BE "VITE_"
// priešdėlio, kad Vite jo neįtrauktų į naršyklės bundle'ą.
export function adminClient() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

// Grąžina { error } (su http status kodu), jei kviečiantis nėra prisijungęs
// adminas — arba { supabaseAdmin } klientą tolesniam naudojimui.
export async function requireAdminCaller(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) {
    return { error: { status: 401, message: "Trūksta prisijungimo žymens." } };
  }

  const supabaseAdmin = adminClient();

  const { data: callerData, error: callerError } = await supabaseAdmin.auth.getUser(token);
  if (callerError || !callerData?.user) {
    return { error: { status: 401, message: "Neteisingas arba pasibaigęs prisijungimas." } };
  }

  const { data: callerProfile } = await supabaseAdmin
    .from("profiles")
    .select("is_admin")
    .eq("id", callerData.user.id)
    .maybeSingle();

  if (!callerProfile?.is_admin) {
    return { error: { status: 403, message: "Tik administratorius gali atlikti šį veiksmą." } };
  }

  return { supabaseAdmin };
}
