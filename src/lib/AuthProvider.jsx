import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { supabase } from "./supabaseClient";
import { idToEmail } from "./authConstants";

export { idToEmail };

const AuthContext = createContext(null);

// Jei DB dar neturi naujo stulpelio (migracija nepaleista), užklausa su juo
// grąžina klaidą ir profilis neįsikeltų — vartotojas neturėtų jokių teisių,
// net adminas. Tada kraunama be jo (užrašinė tiesiog nerodoma).
async function loadProfileRow(userId) {
  const res = await supabase
    .from("profiles")
    .select("id, username, is_admin, tasks_enabled, notes_enabled")
    .eq("id", userId)
    .maybeSingle();
  if (!res.error) return res;
  return supabase.from("profiles").select("id, username, is_admin, tasks_enabled").eq("id", userId).maybeSingle();
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined); // undefined = dar nežinoma, null = neprisijungęs
  const [profile, setProfile] = useState(null);
  const [permissions, setPermissions] = useState(new Set());
  const [palletPermissions, setPalletPermissions] = useState(new Set());
  const [devicePermissions, setDevicePermissions] = useState(new Set());
  const [loadingProfile, setLoadingProfile] = useState(false);

  const loadProfile = useCallback(async (userId) => {
    setLoadingProfile(true);
    const [{ data: profileRow }, { data: permRows }, { data: palletPermRows }, { data: devicePermRows }] = await Promise.all([
      loadProfileRow(userId),
      supabase.from("user_permissions").select("permission").eq("user_id", userId),
      supabase.from("pallet_permissions").select("permission").eq("user_id", userId),
      supabase.from("device_permissions").select("permission").eq("user_id", userId)
    ]);
    setProfile(profileRow || null);
    setPermissions(new Set((permRows || []).map((r) => r.permission)));
    setPalletPermissions(new Set((palletPermRows || []).map((r) => r.permission)));
    setDevicePermissions(new Set((devicePermRows || []).map((r) => r.permission)));
    setLoadingProfile(false);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
      if (data.session?.user) loadProfile(data.session.user.id);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (newSession?.user) {
        loadProfile(newSession.user.id);
      } else {
        setProfile(null);
        setPermissions(new Set());
        setPalletPermissions(new Set());
        setDevicePermissions(new Set());
      }
    });

    return () => sub.subscription.unsubscribe();
  }, [loadProfile]);

  async function signInWithId(id, password) {
    const { error } = await supabase.auth.signInWithPassword({
      email: idToEmail(id),
      password
    });
    return { error };
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  function hasPermission(perm) {
    return !!profile?.is_admin || permissions.has(perm);
  }

  function hasPalletPermission(perm) {
    return !!profile?.is_admin || palletPermissions.has(perm);
  }

  function hasDevicePermission(perm) {
    return !!profile?.is_admin || devicePermissions.has(perm);
  }

  const value = {
    session,
    user: session?.user ?? null,
    profile,
    permissions,
    palletPermissions,
    devicePermissions,
    isAdmin: !!profile?.is_admin,
    // Darbų modulis (/darbai) — adminui visada, kitiems pažymėjus vartotojų puslapyje.
    canUseTasks: !!profile?.is_admin || !!profile?.tasks_enabled,
    // Užrašinė (/uzrasai) — taip pat: adminui visada, kitiems pažymėjus.
    canUseNotes: !!profile?.is_admin || !!profile?.notes_enabled,
    hasPermission,
    hasPalletPermission,
    hasDevicePermission,
    loading: session === undefined || (!!session && loadingProfile && !profile),
    signInWithId,
    signOut
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth turi būti naudojamas AuthProvider viduje");
  return ctx;
}
