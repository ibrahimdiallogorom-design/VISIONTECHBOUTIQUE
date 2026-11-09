/**
 * SahelExpress - Service Worker Résilient (Chapitre 6.2 du Cahier des Charges)
 * - Stratégie CacheFirst pour les images (.webp) et le shell applicatif (HTML, CSS, JS, Manifest)
 * - Stratégie NetworkFirstWithFallbackToCache pour les données API du catalogue (/api/catalog/sync, /api/health)
 */

const SHELL_CACHE_NAME = 'sahelexpress-shell-v2';
const MEDIA_CACHE_NAME = 'sahelexpress-media-v2';
const API_CACHE_NAME = 'sahelexpress-api-v2';

const APP_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/merchant.html',
  '/install.html',
  '/SahelExpress-Mobile-Offline.html',
  '/css/styles.css',
  '/js/db_local.js',
  '/js/app.js',
  '/js/merchant.js',
  '/manifest.json',
  '/media/icon-192.png',
  '/media/icon-512.png'
];

// Installation : Pré-cache immédiat du Shell Applicatif
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activation : Nettoyage des anciens caches obsolètes
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

/**
 * Stratégie CacheFirst : renvoie immédiatement depuis le cache local s'il existe,
 * sinon télécharge et met en cache.
 */
async function cacheFirst(request, cacheName) {
  const cachedResponse = await caches.match(request);
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
  } catch (err) {
    return new Response('Ressource hors-ligne non disponible', { status: 503 });
  }
}

/**
 * Stratégie NetworkFirstWithFallbackToCache : tente le réseau en priorité,
 * met à jour le cache API, et bascule sur le cache en cas de coupure 3G/4G.
 */
async function networkFirstWithFallbackToCache(request, cacheName) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }
    return new Response(
      JSON.stringify({
        offline: true,
        error: 'Mode Hors-Ligne actif : données chargées depuis IndexedDB.'
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

  // 1. Données API du catalogue : NetworkFirstWithFallbackToCache
  if (url.pathname.startsWith('/api/catalog/sync') || url.pathname.startsWith('/api/health')) {
    event.respondWith(networkFirstWithFallbackToCache(request, API_CACHE_NAME));
    return;
  }

  // 2. Miniatures WebP et médias : CacheFirst
  if (url.pathname.startsWith('/media/') || url.pathname.endsWith('.webp')) {
    event.respondWith(cacheFirst(request, MEDIA_CACHE_NAME));
    return;
  }

  // 3. Shell Applicatif (HTML, CSS, JS, Manifest) : CacheFirst
  if (
    url.origin === self.location.origin &&
    (url.pathname === '/' ||
      url.pathname.endsWith('.html') ||
      url.pathname.endsWith('.css') ||
      url.pathname.endsWith('.js') ||
      url.pathname.endsWith('.json'))
  ) {
    event.respondWith(cacheFirst(request, SHELL_CACHE_NAME));
  }
});
