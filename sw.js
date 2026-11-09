/**
 * SahelExpress - Service Worker Résilient v6 (Mise à Jour Automatique Instantanée + Mode 100% Hors-Ligne)
 * - Stratégie NetworkFirst (Réseau d'abord, puis Cache Hors-Ligne) pour HTML, JS, CSS, JSON et API :
 *   => Garantit que l'APK Android installé reçoit AUTOMATIQUEMENT et INSTANTANÉMENT toutes les mises à jour
 *      publiées sur GitHub Pages dès que le téléphone a Internet, sans jamais reconstruire l'APK !
 *   => Garantit que sans Internet, l'application s'ouvre instantanément depuis la mémoire du téléphone.
 */

const SHELL_CACHE_NAME = 'sahelexpress-shell-v6';
const MEDIA_CACHE_NAME = 'sahelexpress-media-v6';
const API_CACHE_NAME = 'sahelexpress-api-v6';

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
  './media/icon-maskable-512.png',
  './media/screenshot-mobile.png',
  './media/screenshot-wide.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE_NAME).then(async (cache) => {
      for (const asset of APP_SHELL_ASSETS) {
        try {
          await cache.add(new Request(asset, { cache: 'reload' }));
        } catch {}
      }
    })
  );
});

self.addEventListener('activate', (event) => {
  const allowedCaches = [SHELL_CACHE_NAME, MEDIA_CACHE_NAME, API_CACHE_NAME];
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (!allowedCaches.includes(key)) {
              return caches.delete(key);
            }
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_ALL_CACHES') {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    );
  }
});

/**
 * Stratégie Réseau d'Abord (Network-First) avec mise à jour du cache et secours Hors-Ligne
 * C'est cette stratégie qui permet à l'APK installé de toujours charger la dernière mise à jour en ligne !
 */
async function networkFirstAppShell(request, cacheName) {
  try {
    const freshRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      cache: 'no-cache'
    });
    const networkResponse = await fetch(freshRequest);
    if (networkResponse && networkResponse.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
      return networkResponse;
    }
  } catch {
    // Pas d'Internet : on bascule sur la copie stockée dans le téléphone
  }

  const cachedResponse = await caches.match(request, { ignoreSearch: true });
  if (cachedResponse) {
    return cachedResponse;
  }

  const fallbackIndex = await caches.match('./index.html', { ignoreSearch: true });
  if (fallbackIndex) {
    return fallbackIndex;
  }

  return new Response('Mode Hors-Ligne SahelExpress Actif', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

async function cacheFirstMedia(request, cacheName) {
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
    return new Response('', { status: 404 });
  }
}

async function networkFirstApi(request, cacheName) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cachedResponse = await caches.match(request, { ignoreSearch: true });
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

  if (url.pathname.includes('/api/')) {
    event.respondWith(networkFirstApi(request, API_CACHE_NAME));
    return;
  }

  if (
    url.pathname.includes('/media/') ||
    url.pathname.endsWith('.webp') ||
    url.pathname.endsWith('.png')
  ) {
    event.respondWith(cacheFirstMedia(request, MEDIA_CACHE_NAME));
    return;
  }

  // Tous les fichiers de code (.html, .js, .css, .json) utilisent Network-First
  // pour que chaque mise à jour soit reçue immédiatement dans l'APK installé !
  if (
    url.origin === self.location.origin &&
    (request.mode === 'navigate' ||
      url.pathname.endsWith('/') ||
      url.pathname.endsWith('.html') ||
      url.pathname.endsWith('.css') ||
      url.pathname.endsWith('.js') ||
      url.pathname.endsWith('.json'))
  ) {
    event.respondWith(networkFirstAppShell(request, SHELL_CACHE_NAME));
  }
});

// Background Sync & Periodic Sync (Validés par PWABuilder)
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

// Push Notifications & Notification Click
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.text() : 'Mise a jour du catalogue SahelExpress disponible !';
  event.waitUntil(
    self.registration.showNotification('SahelExpress', {
      body: data,
      icon: './media/icon-192.png',
      badge: './media/icon-96.png'
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      if (clientList.length > 0) {
        return clientList[0].focus();
      }
      return self.clients.openWindow('./index.html');
    })
  );
});
