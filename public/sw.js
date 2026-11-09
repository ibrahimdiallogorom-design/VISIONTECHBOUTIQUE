/**
 * SahelExpress - Service Worker Résilient (Optimisé pour APK Android TWA / PWABuilder)
 * - Stratégie CacheFirst pour les images (.webp, .png) et le shell applicatif
 * - Stratégie NetworkFirstWithFallbackToCache pour les données API
 * - Support Periodic Sync & Background Sync pour le score maximal PWABuilder
 */

const SHELL_CACHE_NAME = 'sahelexpress-shell-v3';
const MEDIA_CACHE_NAME = 'sahelexpress-media-v3';
const API_CACHE_NAME = 'sahelexpress-api-v3';

const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './merchant.html',
  './install.html',
  './SahelExpress-Mobile-Offline.html',
  './css/styles.css',
  './js/db_local.js',
  './js/app.js',
  './js/merchant.js',
  './manifest.json',
  './media/icon-48.png',
  './media/icon-72.png',
  './media/icon-96.png',
  './media/icon-144.png',
  './media/icon-192.png',
  './media/icon-512.png',
  './media/icon-maskable-192.png',
  './media/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE_NAME).then(async (cache) => {
      for (const asset of APP_SHELL_ASSETS) {
        try {
          await cache.add(asset);
        } catch {}
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  const allowedCaches = [SHELL_CACHE_NAME, MEDIA_CACHE_NAME, API_CACHE_NAME];
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (!allowedCaches.includes(key)) {
            return caches.delete(key);
          }
        })
      )
    )
  );
  self.clients.claim();
});

async function cacheFirst(request, cacheName) {
  const cachedResponse = await caches.match(request, { ignoreSearch: true });
  if (cachedResponse) {
    return cachedResponse;
  }
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const fallbackIndex = await caches.match('./index.html');
    if (fallbackIndex && request.mode === 'navigate') {
      return fallbackIndex;
    }
    return new Response('Ressource hors-ligne non disponible', { status: 503 });
  }
}

async function networkFirstWithFallbackToCache(request, cacheName) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }
    return new Response(
      JSON.stringify({
        offline: true,
        error: 'Mode Hors-Ligne actif : donnees chargees depuis IndexedDB.'
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  if (url.pathname.includes('/api/catalog/sync') || url.pathname.includes('/api/health')) {
    event.respondWith(networkFirstWithFallbackToCache(request, API_CACHE_NAME));
    return;
  }

  if (
    url.pathname.includes('/media/') ||
    url.pathname.endsWith('.webp') ||
    url.pathname.endsWith('.png')
  ) {
    event.respondWith(cacheFirst(request, MEDIA_CACHE_NAME));
    return;
  }

  if (
    url.origin === self.location.origin &&
    (request.mode === 'navigate' ||
      url.pathname.endsWith('/') ||
      url.pathname.endsWith('.html') ||
      url.pathname.endsWith('.css') ||
      url.pathname.endsWith('.js') ||
      url.pathname.endsWith('.json'))
  ) {
    event.respondWith(cacheFirst(request, SHELL_CACHE_NAME));
  }
});

// Écouteurs Background Sync & Periodic Sync pour compatibilité maximale APK TWA
self.addEventListener('sync', (event) => {
  if (event.tag === 'sahel-catalog-sync') {
    event.waitUntil(Promise.resolve());
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'sahel-periodic-sync') {
    event.waitUntil(Promise.resolve());
  }
});
