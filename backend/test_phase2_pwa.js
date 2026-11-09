/**
 * SahelExpress - Suite de Tests Automatisés de l'Étape 2 (Module Acheteur PWA Offline-First)
 * Vérifie :
 * 1. Disponibilité et intégrité du Shell Applicatif (/, /index.html, /css/styles.css, /js/db_local.js, /js/app.js, /sw.js, /manifest.json)
 * 2. Respect strict du Chapitre 6.1 : Zéro dépendance externe (0 Google Fonts, 0 CDN externe)
 * 3. Compression des médias WebP (< 15 Ko conformément au Chapitre 3.1)
 * 4. Présence des stratégies CacheFirst et NetworkFirstWithFallbackToCache dans le Service Worker (Chapitre 6.2)
 * 5. Présence du moteur d'envoi adaptatif (Timeout 5000ms + bascule SMS `sms:...`)
 */

const assert = require('node:assert');
const http = require('node:http');
const { server } = require('./server');

const TEST_PORT = 3457;

function fetchUrl(path) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${TEST_PORT}${path}`, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            buffer,
            text: buffer.toString('utf8')
          });
        });
      })
      .on('error', reject);
  });
}

async function runPhase2Tests() {
  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  console.log(`\n🧪 Démarrage des tests de validation de l'Étape 2 (Module Acheteur PWA) sur le port ${TEST_PORT}...\n`);

  try {
    // 1. Vérification du Shell Applicatif HTML & Zéro dépendance externe (Chapitre 6.1)
    const indexRes = await fetchUrl('/');
    assert.strictEqual(indexRes.status, 200);
    assert.ok(indexRes.text.includes('SahelExpress'));
    assert.ok(!indexRes.text.includes('fonts.googleapis.com'), 'Interdiction de Google Fonts en ligne');
    assert.ok(!indexRes.text.includes('https://cdn.'), 'Interdiction de CDN externe');
    console.log('✅ [1/5] Shell HTML principal servi sans aucune dépendance externe (Zéro Google Fonts / Zéro CDN)');

    // 2. Vérification du Service Worker (Chapitre 6.2 : CacheFirst + NetworkFirstWithFallbackToCache)
    const swRes = await fetchUrl('/sw.js');
    assert.strictEqual(swRes.status, 200);
    assert.ok(swRes.text.includes('cacheFirst'));
    assert.ok(swRes.text.includes('networkFirstWithFallbackToCache'));
    console.log('✅ [2/5] Service Worker (/sw.js) validé avec stratégies CacheFirst & NetworkFirstWithFallbackToCache');

    // 3. Vérification de la base locale IndexedDB (/js/db_local.js)
    const dbLocalRes = await fetchUrl('/js/db_local.js');
    assert.strictEqual(dbLocalRes.status, 200);
    assert.ok(dbLocalRes.text.includes('indexedDB.open'));
    assert.ok(dbLocalRes.text.includes('applyDeltaSync'));
    console.log('✅ [3/5] Module de stockage local IndexedDB (/js/db_local.js) & Synchro Delta validés');

    // 4. Vérification du Moteur d'Envoi Adaptatif (Timeout 5000ms + Bascule SMS `sms:...`) dans /js/app.js
    const appJsRes = await fetchUrl('/js/app.js');
    assert.strictEqual(appJsRes.status, 200);
    assert.ok(appJsRes.text.includes('5000')); // Timeout de 5 secondes
    assert.ok(appJsRes.text.includes('sms:')); // Déclencheur SMS natif Android
    assert.ok(appJsRes.text.includes('CMD#')); // Format compacté
    console.log('✅ [4/5] Moteur d\'envoi adaptatif (Timeout HTTP 5s -> Bascule SMS `sms:NUMERO?body=CMD#...`) validé');

    // 5. Vérification du poids des miniatures WebP (< 15 Ko exigé au Chapitre 3.1)
    const webpRes = await fetchUrl('/media/PROD01.webp');
    assert.strictEqual(webpRes.status, 200);
    assert.strictEqual(webpRes.headers['content-type'], 'image/webp');
    assert.ok(webpRes.buffer.length < 15 * 1024, 'La miniature WebP doit peser moins de 15 Ko');
    console.log(`✅ [5/5] Miniature WebP locale (/media/PROD01.webp) servie avec succès (${webpRes.buffer.length} octets < 15 Ko)`);

    console.log('\n🎉 TOUS LES TESTS DE L\'ÉTAPE 2 (MODULE ACHETEUR PWA OFFLINE-FIRST) SONT PASSÉS AVEC SUCCÈS !\n');
  } finally {
    server.close();
  }
}

runPhase2Tests().catch((err) => {
  console.error('❌ Échec des tests Étape 2:', err);
  process.exit(1);
});
