// Service worker — TIK Web Push pranešimams (žr. api/push.js, src/lib/push.js).
// Jokio puslapių kešavimo (nėra "fetch" handler'io), todėl programa visada
// kraunama iš tinklo kaip ir anksčiau.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "IT Partner", {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: data.tag,
      renotify: !!data.tag,
      requireInteraction: true, // kompiuteryje lieka, kol paspaudi
      data: { url: data.url || "/darbai" }
    })
  );
});

// Paspaudus — atidaromas jau atviras programos langas (ir nueinama į /darbai)
// arba naujas.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/darbai", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (existing) {
        return existing.focus().then((w) => (w && "navigate" in w ? w.navigate(url) : w));
      }
      return self.clients.openWindow(url);
    })
  );
});
