// Cofrinho — service worker
// Sempre busca a versão mais nova na rede (sem cache HTTP) e só usa a cópia guardada se estiver offline.
const CACHE = "cofrinho-v14";
const FILES = ["./", "index.html", "config.js", "supabase.js", "591.supabase.js", "manifest.webmanifest", "piggy.svg", "icon-180.png", "icon-192.png", "icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: "reload" }))))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // nuvem e fontes: direto na rede
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then(r => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); } return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match("index.html")))
  );
});
