/**
 * SahelExpress - Suite de Tests Automatisés Multi-Commerçants (Isolation SaaS) & Onboarding WhatsApp Acheteurs
 */

const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');
const { server } = require('./server');

const TEST_PORT = 3460;

function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Accept-Encoding': 'br, gzip' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
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
          let json = null;
          try {
            json = JSON.parse(decoded.toString('utf8'));
          } catch {}
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runMultiTenantTests() {
  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  console.log(`\n🧪 Démarrage des tests d'Isolation Multi-Commerçants & WhatsApp Acheteurs sur le port ${TEST_PORT}...\n`);

  try {
    // 1. Vérifier que l'accès aux données privées commerçant sans compte est bloqué (HTTP 401)
    const unauthRes = await request('GET', '/api/merchants/customers');
    assert.strictEqual(unauthRes.status, 401);
    console.log('✅ [1/5] Accès Commerçant sans compte bloqué avec succès (HTTP 401 Unauthorized)');

    // 2. Connexion Commerçant 1 (M-SAHEL) et Commerçant 2 (M-DORI)
    const login1 = await request('POST', '/api/merchants/login', {
      telephone: '+22670001122',
      password: '1234'
    });
    assert.strictEqual(login1.status, 200);
    const token1 = login1.json.token;

    const login2 = await request('POST', '/api/merchants/login', {
      telephone: '+22676003344',
      password: '5678'
    });
    assert.strictEqual(login2.status, 200);
    const token2 = login2.json.token;
    console.log(`✅ [2/5] Connexion simultanée de 2 comptes commerçants distincts validée (${login1.json.merchant.nom_boutique} & ${login2.json.merchant.nom_boutique})`);

    // 3. Vérifier qu'un commerçant NE PEUT PAS modifier le stock d'un autre commerçant (HTTP 403)
    // PROD01 appartient à M-SAHEL. On tente de le modifier avec le token de M-DORI (token2) :
    const forbiddenPatch = await request(
      'PATCH',
      '/api/articles/PROD01',
      { prix_unitaire: 99999 },
      token2
    );
    assert.strictEqual(forbiddenPatch.status, 403);
    console.log('✅ [3/5] Isolation stricte validée : le Commerçant 2 ne peut pas modifier les articles du Commerçant 1 (HTTP 403 Forbidden)');

    // 4. Onboarding d'un Acheteur à l'ouverture (Nom + Numéro WhatsApp)
    const onboardRes = await request('POST', '/api/buyers/onboard', {
      nom_complet: 'Mariam Ouédraogo',
      whatsapp: '+22675123456',
      ville: 'Gorom-Gorom',
      secteur_quartier: 'SEC2',
      point_repere: 'École Centre'
    });
    assert.strictEqual(onboardRes.status, 200);
    assert.strictEqual(onboardRes.json.client.whatsapp, '+22675123456');
    console.log(`✅ [4/5] Enregistrement Acheteur à l'ouverture validé (${onboardRes.json.client.nom_complet} — WhatsApp: ${onboardRes.json.client.whatsapp})`);

    // 5. Dépôt d'un avis + suggestion de produit et vérification dans le CRM du commerçant ciblé
    const reviewRes = await request('POST', '/api/reviews', {
      commercant_id: 'M-SAHEL',
      article_id: 'PROD01',
      client_id: onboardRes.json.client.id,
      client_nom: 'Mariam Ouédraogo',
      client_whatsapp: '+22675123456',
      note: 5,
      commentaire: 'Excellent service hors-ligne !',
      suggestion_produit: 'Congélateur solaire 12V'
    });
    assert.strictEqual(reviewRes.status, 201);

    const crm1 = await request('GET', '/api/merchants/customers', null, token1);
    const crm2 = await request('GET', '/api/merchants/customers', null, token2);

    assert.ok(crm1.json.avis.some((a) => a.suggestion_produit === 'Congélateur solaire 12V'));
    assert.ok(!crm2.json.avis.some((a) => a.suggestion_produit === 'Congélateur solaire 12V'));
    console.log('✅ [5/5] Base de données Avis & Suggestions WhatsApp isolée par commerçant validée !');

    console.log('\n🎉 TOUS LES TESTS MULTI-COMMERÇANTS & CRM WHATSAPP SONT PASSÉS AVEC SUCCÈS !\n');
  } finally {
    server.close();
  }
}

runMultiTenantTests().catch((err) => {
  console.error('❌ Échec des tests Multi-Commerçants:', err);
  process.exit(1);
});
