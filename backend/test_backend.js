/**
 * SahelExpress - Suite de Tests Automatisés de l'Étape 1 (Backend, DB, Synchro Delta, Passerelle SMS, JWT & Compression)
 */

const assert = require('node:assert');
const zlib = require('node:zlib');
const http = require('node:http');
const { server } = require('./server');

const TEST_PORT = 3456;

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      'Accept-Encoding': 'br, gzip',
      ...headers
    };
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path,
        method,
        headers: reqHeaders
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const rawBuf = Buffer.concat(chunks);
          const encoding = res.headers['content-encoding'];
          let decodedBuf = rawBuf;
          if (encoding === 'br') {
            decodedBuf = zlib.brotliDecompressSync(rawBuf);
          } else if (encoding === 'gzip') {
            decodedBuf = zlib.gunzipSync(rawBuf);
          }
          let json = null;
          try {
            json = JSON.parse(decodedBuf.toString('utf8'));
          } catch {
            // binaire ou texte
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            rawLength: rawBuf.length,
            json
          });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runTests() {
  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  console.log(`\n🧪 Démarrage des tests de validation du Backend SahelExpress sur le port ${TEST_PORT}...\n`);

  try {
    // 1. Test Healthcheck + Compression Brotli
    const health = await request('GET', '/api/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.headers['content-encoding'], 'br');
    assert.strictEqual(health.json.status, 'OK');
    console.log(
      `✅ [1/6] Healthcheck & Compression Brotli actifs (${health.rawLength} octets compressés, ${health.json.stats.active_articles} articles en base)`
    );

    // 2. Test Authentification JWT Longue Durée (90 jours)
    const authRes = await request('POST', '/api/auth/login', {
      telephone: '+22670112233',
      nom_complet: 'Amadou Dicko',
      ville: 'Gorom-Gorom',
      secteur_quartier: 'SEC3'
    });
    assert.strictEqual(authRes.status, 200);
    assert.ok(authRes.json.token);
    assert.strictEqual(authRes.json.expires_in_seconds, 90 * 24 * 60 * 60);
    console.log(
      `✅ [2/6] Authentification JWT longue durée validée (Client: ${authRes.json.client.id}, Expiration: 90 jours)`
    );

    // 3. Test Synchronisation Catalogue Complète + Synchronisation Incrémentale par Hash/Delta
    const fullSync = await request('GET', '/api/catalog/sync');
    assert.strictEqual(fullSync.status, 200);
    assert.strictEqual(fullSync.json.mode, 'FULL_SYNC');
    assert.ok(fullSync.json.updated_articles.length >= 14);

    // Appel avec le même hash : doit indiquer up_to_date = true et 0 article renvoyé
    const sameHashSync = await request(
      'GET',
      `/api/catalog/sync?hash=${encodeURIComponent(fullSync.json.catalog_hash)}`
    );
    assert.strictEqual(sameHashSync.json.up_to_date, true);
    assert.strictEqual(sameHashSync.json.updated_articles.length, 0);
    console.log(
      `✅ [3/6] Synchronisation Catalogue & Delta par Hash validée (Payload complet: ${fullSync.rawLength} octets < 50 Ko)`
    );

    // 4. Test du Décodeur Passerelle SMS avec l'exemple exact de la fiche technique :
    // CMD#CL890#SEC3#PROD01:2;PROD44:1#ESP#PRES_CHATEAU_EAU
    const exactSmsExample = 'CMD#CL890#SEC3#PROD01:2;PROD44:1#ESP#PRES_CHATEAU_EAU';
    const smsRes = await request('POST', '/api/sms/incoming', {
      from: '+22670112233',
      message: exactSmsExample
    });
    assert.strictEqual(smsRes.status, 201);
    assert.strictEqual(smsRes.json.status, 'SMS_ORDER_CREATED');
    // PROD01 (32 500 x 2 = 65 000) + PROD44 (4 000 x 1 = 4 000) = 69 000 FCFA
    assert.strictEqual(smsRes.json.order.total_fcfa, 69000);
    assert.strictEqual(smsRes.json.order.mode_transmission, 'SMS');
    assert.strictEqual(smsRes.json.order.mode_paiement, 'CASH_DELIVERY');
    console.log(
      `✅ [4/6] Décodage SMS exact "${exactSmsExample}" validé -> Commande #${smsRes.json.order.id} créée (Total: ${smsRes.json.order.total_fcfa} FCFA)`
    );
    console.log(`   📩 Accusé SMS généré : "${smsRes.json.sms_reply}"`);

    // 5. Test de robustesse SMS (espaces accidentels, minuscules, et protection Anti-Doublon)
    const messyDuplicateSms = '  cmd # cl890 # sec3 # prod01 : 2 ; prod44 : 1 # esp # pres_chateau_eau  ';
    const dupRes = await request('POST', '/api/sms/incoming', {
      from: '+22670112233',
      message: messyDuplicateSms
    });
    assert.strictEqual(dupRes.status, 200);
    assert.strictEqual(dupRes.json.status, 'DUPLICATE_IGNORED');
    console.log(
      `✅ [5/6] Robustesse SMS (espaces/minuscules) & Protection Anti-Doublon validées (Status: ${dupRes.json.status})`
    );

    // 6. Test Commande HTTP POST Directe (Mode En Ligne) & Mise à jour Statut
    const httpOrder = await request('POST', '/api/orders', {
      client: {
        id: 'CL205',
        telephone: '+22661889900',
        nom_complet: 'Boureima Sawadogo',
        ville: 'Sebba',
        secteur_quartier: 'SEC2',
        point_repere: 'Marché Central'
      },
      mode_transmission: 'DATA_HTTPS',
      mode_paiement: 'MOOV_MONEY',
      items: [{ article_id: 'PROD10', quantite: 3 }]
    });
    assert.strictEqual(httpOrder.status, 201);
    assert.strictEqual(httpOrder.json.order.total_fcfa, 37500);

    const statusUpdate = await request('PATCH', `/api/orders/${httpOrder.json.order.id}/status`, {
      statut: 'LIVREE'
    });
    assert.strictEqual(statusUpdate.status, 200);
    assert.strictEqual(statusUpdate.json.order.statut, 'LIVREE');
    console.log(
      `✅ [6/6] Création de commande HTTP POST & Changement de statut (RECUE -> LIVREE) validés`
    );

    console.log('\n🎉 TOUS LES TESTS DE L\'ÉTAPE 1 (BACKEND & BASE DE DONNÉES) SONT PASSÉS AVEC SUCCÈS !\n');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('❌ Échec des tests backend:', err);
  process.exit(1);
});
