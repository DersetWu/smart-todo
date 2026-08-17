/* ================================================================
   Smart Todo — Service Worker
   Cache-first strategy for app shell, network-first for data
   ================================================================ */

const CACHE_NAME = 'smart-todo-v3';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
];

// Install: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// Fetch: cache-first for app shell, network-only for everything else
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET requests
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;

  // Cache-first for the app shell
  if (STATIC_ASSETS.some(a => url.pathname.endsWith(a.replace('./', ''))) || url.pathname === '/' || url.pathname.endsWith('index.html')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const fetchPromise = fetch(event.request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
  }
  // For everything else, try network, fall back to cache
  else {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
  }
});
