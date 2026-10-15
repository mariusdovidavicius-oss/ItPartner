import { supabase } from "./supabaseClient";

// Web Push naršyklės pusė: service worker registracija, pranešimų
// įjungimas/išjungimas šiame įrenginyje ir pranešimo užklausa serveriui
// (api/push.js). Prenumerata saugoma push_subscriptions lentelėje.

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

export function pushSupported() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && !!VAPID_PUBLIC_KEY;
}

// iPhone/iPad pranešimus leidžia tik programai, pridėtai prie pradžios ekrano.
export function needsHomeScreenInstall() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone;
  return ios && !standalone;
}

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("Service worker neužsiregistravo:", err));
}

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// navigator.serviceWorker.ready niekada neišsipildo, jei service worker
// neužsiregistravo — tada po kelių sekundžių klaida, o ne amžinas laukimas.
function swReady() {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Service worker neveikia.")), 8000))
  ]);
}

async function currentSubscription() {
  const reg = await swReady();
  return reg.pushManager.getSubscription();
}

// "on" — šis įrenginys gauna pranešimus; "off" — ne; "denied" — naršyklėje
// pranešimai užblokuoti (atblokuoti galima tik naršyklės nustatymuose).
export async function getPushState() {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const sub = await currentSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "denied" : "Pranešimai neleisti.");
  const reg = await swReady();
  const sub =
    (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) }));
  const json = sub.toJSON();
  const { error } = await supabase.rpc("save_push_subscription", {
    p_endpoint: json.endpoint,
    p_p256dh: json.keys.p256dh,
    p_auth: json.keys.auth,
    p_user_agent: navigator.userAgent.slice(0, 300)
  });
  if (error) throw new Error(error.message);
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
  await sub.unsubscribe();
}

// Prašo serverio išsiųsti pranešimą. Nepavykus — tik įspėjimas konsolėje:
// pranešimas yra priedas, darbas jau sukurtas.
export async function sendPush(body) {
  try {
    const { data } = await supabase.auth.getSession();
    const res = await fetch("/api/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token}` },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  } catch (err) {
    console.warn("Pranešimo išsiųsti nepavyko:", err);
    throw err;
  }
}
