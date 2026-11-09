/**
 * SahelExpress - Suite de Tests Automatisés de l'Étape 3 (Module Gestion & Dispatch Commerçant / Livreur)
 * Vérifie :
 * 1. Disponibilité de l'interface Commerçant (/merchant.html et /js/merchant.js) sans dépendance externe
 * 2. Présence du bouton d'appel téléphonique direct en 1 clic (`tel:`) et du générateur thermique 58mm/80mm
 * 3. File de commandes unifiée (Data HTTPS + SMS) via GET /api/orders
 * 4. Mise à jour des stocks et push du catalogue via PATCH /api/articles/:id + Vérification de la Synchro Delta (`since`)
 */

const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');
const { server } = require('./server');

const TEST_PORT = 3458;

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Accept-Encoding': 'br, gzip' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      { hostname: '127.0.0.1', port: TEST_PORT, path, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const rawBuf = Buffer.concat(chunks);
          const enc = res.headers['content-encoding'];
          let decoded = rawBuf;
          if (enc === 'br') decoded = zlib.brotliDecompressSync(rawBuf);
          else if (enc === 'gzip') decoded = zlib.gunzipSync(rawBuf);

          const text = decoded.toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // HTML ou JS
          }
          resolve({ status: res.statusCode, text, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runPhase3Tests() {
  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  console.log(`\n🧪 Démarrage des tests de validation de l'Étape 3 (Module Gestion & Dispatch) sur le port ${TEST_PORT}...\n`);

  try {
    // 1. Vérification de /merchant.html et /js/merchant.js
    const htmlRes = await request('GET', '/merchant.html');
    assert.strictEqual(htmlRes.status, 200);
    assert.ok(htmlRes.text.includes('Gestion & Dispatch'));

    const jsRes = await request('GET', '/js/merchant.js');
    assert.strictEqual(jsRes.status, 200);
    assert.ok(jsRes.text.includes('tel:'), 'Présence du bouton d\'appel téléphonique en 1 clic');
    assert.ok(jsRes.text.includes('58mm') && jsRes.text.includes('80mm'), 'Support de l\'impression thermique 58mm/80mm');
    console.log('✅ [1/4] Interface Commerçant (/merchant.html & /js/merchant.js) validée (Appel 1-clic `tel:` + Thermique 58mm/80mm)');

    // 2. Vérification de la file de commandes unifiée (Data HTTPS + SMS)
    const ordersRes = await request('GET', '/api/orders');
    assert.strictEqual(ordersRes.status, 200);
    const hasSms = ordersRes.json.orders.some((o) => o.mode_transmission === 'SMS');
    const hasData = ordersRes.json.orders.some((o) => o.mode_transmission === 'DATA_HTTPS');
    assert.ok(hasSms && hasData, 'La file unifiée doit contenir à la fois les commandes Data HTTPS et SMS');
    console.log(`✅ [2/4] File temps réel unifiée (Data HTTPS + SMS) validée (${ordersRes.json.count} commandes actives)`);

    // 3. Mise à jour du stock et prix par le commerçant (Push Delta)
    const beforeSync = await request('GET', '/api/catalog/sync');
    const previousTimestamp = beforeSync.json.sync_timestamp;
    const previousHash = beforeSync.json.catalog_hash;

    // Pause de 15ms pour garantir un timestamp strictement supérieur
    await new Promise((r) => setTimeout(r, 15));

    const patchRes = await request('PATCH', '/api/articles/PROD02', {
      prix_unitaire: 4250,
      stock_disponible: 95
    });
    assert.strictEqual(patchRes.status, 200);
    assert.NotStrictEqual;
    assert.notStrictEqual(patchRes.json.catalog_hash, previousHash);
    console.log(`✅ [3/4] Mise à jour Stock/Prix Commerçant validée (Nouveau Hash Catalogue: ${patchRes.json.catalog_hash})`);

    // 4. Vérification que la synchronisation incrémentale (`since`) ne renvoie QUE l'article modifié PROD02
    const deltaRes = await request(
      'GET',
      `/api/catalog/sync?since=${encodeURIComponent(previousTimestamp)}`
    );
    assert.strictEqual(deltaRes.status, 200);
    assert.strictEqual(deltaRes.json.mode, 'DELTA_SYNC');
    assert.strictEqual(deltaRes.json.updated_articles.length, 1);
    assert.strictEqual(deltaRes.json.updated_articles[0].id, 'PROD02');
    assert.strictEqual(deltaRes.json.updated_articles[0].prix_unitaire, 4250);
    console.log('✅ [4/4] Synchronisation Delta validée : seul l\'article modifié (PROD02) est poussé aux clients !');

    console.log('\n🎉 TOUS LES TESTS DE L\'ÉTAPE 3 (GESTION & DISPATCH COMMERÇANT / LIVREUR) SONT PASSÉS AVEC SUCCÈS !\n');
  } finally {
    server.close();
  }
}

runPhase3Tests().catch((err) => {
  console.error('❌ Échec des tests Étape 3:', err);
  process.exit(1);
});
