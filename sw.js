// Guarda o app para abrir mesmo sem internet. Os dados ficam no aparelho, não aqui.
const CACHE = "caderno-gastos-v4";
const FILES = ["./", "index.html", "config.js", "supabase.js", "591.supabase.js", "manifest.webmanifest", "piggy.svg", "icon-180.png", "icon-192.png", "icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  // rede primeiro (pega atualizações), cache se estiver offline
  e.respondWith(fetch(e.request).then(r => { if (r.ok && new URL(e.request.url).origin === location.origin) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); } return r; }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});
