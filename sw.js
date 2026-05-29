/* NSAMS service worker — offline-first app shell.
 *
 * Strategy:
 *   - Precache the known shells we can list (root + teacher + shared db).
 *   - Navigations: network-first, fall back to cache, then to the root shell.
 *   - Other same-origin GETs: stale-while-revalidate (fast + self-updating).
 *   - Cross-origin (Supabase API, Google Fonts) is left to the network.
 *
 * NOTE: no self.skipWaiting(). A new SW activates only once old tabs close,
 * which avoids serving a half-updated mix of old HTML + new JS mid-session.
 * Bump CACHE on every deploy so old caches are purged on activate.
 */
const CACHE = 'nsams-v1';

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './shared/db.js',
  './teacher/index.html',
  './teacher/script.js',
  './teacher/style.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // allSettled: a single 404 must not abort the whole precache.
      Promise.allSettled(PRECACHE.map((url) => cache.add(url)))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase / fonts → network

  // HTML navigations: prefer fresh, fall back to cache, then to shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => hit || caches.match('./index.html'))
        )
    );
    return;
  }

  // Static same-origin assets: serve cache immediately, refresh in background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
