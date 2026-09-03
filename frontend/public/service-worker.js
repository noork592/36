/* JK Products Factory PWA — service worker
 * Security-aware caching:
 *   - /api/*           → NETWORK-ONLY. Never cache API responses to avoid
 *                        leaking authenticated data between sessions (e.g.,
 *                        after logout on a shared device).
 *   - Hashed bundles
 *     (/static/*)      → CACHE-FIRST. CRA hashes filenames so cached
 *                        bundles are always fresh per deploy.
 *   - HTML navigations → NETWORK-FIRST, fall back to cached "/" when
 *                        offline so the shell still boots on the factory
 *                        floor.
 *   - Other same-origin → STALE-WHILE-REVALIDATE for icons / manifest.
 *   - Non-GET requests are passed straight through.
 *
 *   On logout the SPA posts {type:"jk-logout"} which clears all caches
 *   so the next user starts with a clean slate.
 */
const CACHE_VERSION = "facedook-v23-icons";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const STATIC_CACHE = `${CACHE_VERSION}-static`;

const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/favicon.png",
  "/logo192.png",
  "/logo512.png",
  "/logo-original.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_ASSETS)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "jk-logout") {
    // Wipe every cache the SW owns so cached HTML/JS doesn't leak any
    // user-specific markup back to the next user on the device.
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))),
    );
  }
  if (event.data && event.data.type === "SKIP_WAITING") {
    // The SPA can fast-track a waiting worker so a fresh JS bundle
    // ships without requiring the user to re-add to home screen.
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 1) API requests — always go to network, no cache. Bypasses the SW
  //    entirely so auth headers / Set-Cookie are never observed by it.
  if (url.pathname.startsWith("/api/")) {
    // No respondWith() ⇒ default browser fetch handles it.
    return;
  }

  // 2) Same-origin static bundles — cache-first (filenames are content-hashed).
  if (url.origin === self.location.origin && url.pathname.startsWith("/static/")) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        });
      }),
    );
    return;
  }

  // 3) HTML navigations — network-first with offline shell fallback.
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Refresh the cached shell for offline boots.
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put("/", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("/") || caches.match("/index.html")),
    );
    return;
  }

  // 4) Other same-origin assets — stale-while-revalidate.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      }),
    );
  }
});
