import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { supabase } from "./supabaseClient";
import { idToEmail } from "./authConstants";

export { idToEmail };

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined); // undefined = dar nežinoma, null = neprisijungęs
  const [profile, setProfile] = useState(null);
  const [permissions, setPermissions] = useState(new Set());
  const [loadingProfile, setLoadingProfile] = useState(false);

  const loadProfile = useCallback(async (userId) => {
    setLoadingProfile(true);
    const [{ data: profileRow }, { data: permRows }] = await Promise.all([
      supabase.from("profiles").select("id, username, is_admin").eq("id", userId).maybeSingle(),
      supabase.from("user_permissions").select("permission").eq("user_id", userId)
    ]);
    setProfile(profileRow || null);
    setPermissions(new Set((permRows || []).map((r) => r.permission)));
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

  const value = {
    session,
    user: session?.user ?? null,
    profile,
    permissions,
    isAdmin: !!profile?.is_admin,
    hasPermission,
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
