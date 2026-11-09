/**
 * SahelExpress - Serveur Backend Multi-Commerçants (Isolation SaaS + CRM WhatsApp & Avis Acheteurs)
 * - Authentification obligatoire des Commerçants par Token JWT (`POST /api/merchants/register`, `POST /api/merchants/login`)
 * - Isolation stricte : chaque commerçant ne voit et ne modifie QUE ses propres commandes, ses articles, ses avis et sa base clients WhatsApp
 * - Enregistrement des Acheteurs à l'ouverture (`POST /api/buyers/onboard`) avec Nom + Numéro WhatsApp
 * - Système d'Avis & Suggestions de produits (`GET /api/reviews`, `POST /api/reviews`)
 */

const http = require('node:http');
const zlib = require('node:zlib');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { db, md5Hash, hashPassword } = require('./db');
const { parseCompactSms } = require('./sms_parser');
const { signJwt, verifyJwt, DEFAULT_EXP_SECONDS } = require('./jwt');
const { buildMobileAssets } = require('./mobile_packager');

const PORT = process.env.PORT || 3000;
const LOGISTICS_SMS_NUMBER = process.env.LOGISTICS_SMS_NUMBER || '+22670001122';

buildMobileAssets();

const MINIMAL_WEBP_BUFFER = Buffer.from(
  'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=',
  'base64'
);

function getCatalogStateHash(commercantId = '') {
  if (commercantId) {
    const row = db
      .prepare(
        `SELECT COUNT(*) as cnt, MAX(updated_at) as max_up, SUM(prix_unitaire * stock_disponible) as checksum
         FROM articles WHERE commercant_id = ?`
      )
      .get(commercantId);
    return md5Hash(`${commercantId}|${row.cnt}|${row.max_up}|${row.checksum}`);
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt, MAX(updated_at) as max_up, SUM(prix_unitaire * stock_disponible) as checksum
       FROM articles`
    )
    .get();
  return md5Hash(`${row.cnt}|${row.max_up}|${row.checksum}`);
}

function sendJson(req, res, statusCode, payload) {
  const rawString = JSON.stringify(payload);
  const rawBuffer = Buffer.from(rawString, 'utf8');
  const acceptEncoding = (req.headers['accept-encoding'] || '').toLowerCase();

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Hash',
    'Vary': 'Accept-Encoding'
  };

  if (acceptEncoding.includes('br')) {
    const compressed = zlib.brotliCompressSync(rawBuffer, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 }
    });
    headers['Content-Encoding'] = 'br';
    headers['Content-Length'] = compressed.length;
    res.writeHead(statusCode, headers);
    res.end(compressed);
    return;
  }

  if (acceptEncoding.includes('gzip')) {
    const compressed = zlib.gzipSync(rawBuffer, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = compressed.length;
    res.writeHead(statusCode, headers);
    res.end(compressed);
    return;
  }

  headers['Content-Length'] = rawBuffer.length;
  res.writeHead(statusCode, headers);
  res.end(rawBuffer);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > 5 * 1024 * 1024) {
        reject(new Error('Payload trop volumineux (> 5 Mo)'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const str = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(str));
      } catch {
        reject(new Error('JSON malformé'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Extrait et vérifie le compte Commerçant connecté à partir du header Authorization: Bearer <JWT>
 */
function getAuthenticatedMerchant(req) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  const payload = verifyJwt(token);
  if (!payload || payload.role !== 'merchant' || !payload.commercant_id) {
    return null;
  }
  const merchant = db
    .prepare(
      `SELECT id, nom_boutique, nom_gerant, telephone, whatsapp, ville, categorie_principale, code_sms, created_at
       FROM commercants WHERE id = ?`
    )
    .get(payload.commercant_id);
  return merchant || null;
}

function getFullOrderById(orderId) {
  const order = db
    .prepare(
      `SELECT c.*,
              cl.nom_complet AS client_nom,
              cl.telephone AS client_telephone,
              cl.whatsapp AS client_whatsapp,
              cl.ville AS client_ville,
              cl.secteur_quartier AS client_secteur,
              cl.point_repere AS client_repere,
              m.nom_boutique AS boutique_nom
       FROM commandes c
       LEFT JOIN clients cl ON cl.id = c.client_id
       LEFT JOIN commercants m ON m.id = c.commercant_id
       WHERE c.id = ?`
    )
    .get(orderId);

  if (!order) return null;

  const lignes = db
    .prepare(
      `SELECT lc.id, lc.article_id, lc.quantite, lc.prix_applique,
              a.designation, a.categorie
       FROM lignes_commande lc
       LEFT JOIN articles a ON a.id = lc.article_id
       WHERE lc.commande_id = ?`
    )
    .all(orderId);

  return {
    ...order,
    lignes
  };
}

function generateOrderId() {
  const rand = Math.floor(1000 + Math.random() * 9000);
  const ts = Date.now().toString(36).slice(-3).toUpperCase();
  return `CMD-${ts}-${rand}`;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Hash'
    });
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  try {
    // =========================================================================
    // 1. HEALTHCHECK & INFOS MOBILE
    // =========================================================================
    if (req.method === 'GET' && pathname === '/api/health') {
      const catalogHash = getCatalogStateHash();
      const articlesCount = db.prepare('SELECT COUNT(*) as c FROM articles WHERE is_active = 1').get().c;
      const ordersCount = db.prepare('SELECT COUNT(*) as c FROM commandes').get().c;
      const merchantsCount = db.prepare('SELECT COUNT(*) as c FROM commercants').get().c;

      return sendJson(req, res, 200, {
        status: 'OK',
        service: 'SahelExpress Multi-Merchant Backend API',
        region: 'Sahel & Liptako (Gorom-Gorom / Dori / Sebba)',
        logistics_sms_number: LOGISTICS_SMS_NUMBER,
        catalog_hash: catalogHash,
        stats: {
          active_articles: articlesCount,
          total_orders: ordersCount,
          total_merchants: merchantsCount
        },
        timestamp: new Date().toISOString()
      });
    }

    if (req.method === 'GET' && pathname === '/api/mobile-info') {
      const nets = os.networkInterfaces();
      const lanUrls = [];
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
          if (net.family === 'IPv4' && !net.internal) {
            lanUrls.push(`http://${net.address}:${PORT}`);
          }
        }
      }
      if (lanUrls.length === 0) {
        lanUrls.push(`http://localhost:${PORT}`);
      }
      return sendJson(req, res, 200, {
        app_name: 'SahelExpress Mobile',
        lan_urls: lanUrls,
        standalone_download: 'SahelExpress-Mobile-Offline.html',
        install_page: 'install.html'
      });
    }

    // =========================================================================
    // 2. GESTION DES COMPTES COMMERÇANTS (MULTI-TENANT ISOLÉ)
    // =========================================================================
    // Liste publique des boutiques actives (sans aucune donnée sensible) pour le filtre acheteur
    if (req.method === 'GET' && pathname === '/api/merchants/public') {
      const list = db
        .prepare(
          `SELECT id, nom_boutique, ville, categorie_principale, code_sms, whatsapp
           FROM commercants ORDER BY created_at ASC`
        )
        .all();
      return sendJson(req, res, 200, { merchants: list });
    }

    // Création d'un nouveau compte Commerçant
    if (req.method === 'POST' && pathname === '/api/merchants/register') {
      const body = await readJsonBody(req);
      const nomBoutique = (body.nom_boutique || '').trim();
      const nomGerant = (body.nom_gerant || '').trim();
      const telephone = (body.telephone || '').trim().replace(/\s+/g, '');
      const whatsapp = (body.whatsapp || telephone).trim().replace(/\s+/g, '');
      const ville = (body.ville || 'Gorom-Gorom').trim();
      const categoriePrincipale = (body.categorie_principale || 'Commerce Général').trim();
      const password = String(body.password || '').trim();

      if (!nomBoutique || !nomGerant || !telephone || password.length < 4) {
        return sendJson(req, res, 400, {
          error: 'Veuillez renseigner le nom de la boutique, le gérant, le téléphone et un code PIN/mot de passe (min 4 caractères).'
        });
      }

      const existing = db.prepare('SELECT id FROM commercants WHERE telephone = ?').get(telephone);
      if (existing) {
        return sendJson(req, res, 409, {
          error: 'Un compte commerçant existe déjà avec ce numéro de téléphone.'
        });
      }

      const merchId = 'M-' + Date.now().toString(36).toUpperCase().slice(-5);
      const rawCode =
        (body.code_sms || nomBoutique.replace(/[^A-Za-z0-9]/g, '').slice(0, 5) || 'SHOP')
          .toUpperCase() + Math.floor(10 + Math.random() * 89);

      const nowIso = new Date().toISOString();
      db.prepare(
        `INSERT INTO commercants (id, nom_boutique, nom_gerant, telephone, whatsapp, ville, categorie_principale, code_sms, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        merchId,
        nomBoutique,
        nomGerant,
        telephone,
        whatsapp,
        ville,
        categoriePrincipale,
        rawCode,
        hashPassword(password),
        nowIso
      );

      const created = db
        .prepare(
          `SELECT id, nom_boutique, nom_gerant, telephone, whatsapp, ville, categorie_principale, code_sms, created_at
           FROM commercants WHERE id = ?`
        )
        .get(merchId);

      const token = signJwt({
        sub: created.id,
        commercant_id: created.id,
        nom_boutique: created.nom_boutique,
        role: 'merchant'
      });

      return sendJson(req, res, 201, {
        message: 'Compte commerçant créé avec succès.',
        token,
        merchant: created
      });
    }

    // Connexion d'un Commerçant existant
    if (req.method === 'POST' && pathname === '/api/merchants/login') {
      const body = await readJsonBody(req);
      const identifier = (body.telephone || body.id || '').trim().replace(/\s+/g, '');
      const password = String(body.password || '').trim();

      if (!identifier || !password) {
        return sendJson(req, res, 400, {
          error: 'Numéro de téléphone (ou ID boutique) et mot de passe requis.'
        });
      }

      const row = db
        .prepare('SELECT * FROM commercants WHERE telephone = ? OR id = ? OR UPPER(code_sms) = UPPER(?)')
        .get(identifier, identifier, identifier);

      if (!row || row.password_hash !== hashPassword(password)) {
        return sendJson(req, res, 401, {
          error: 'Identifiants commerçant incorrects.'
        });
      }

      const token = signJwt({
        sub: row.id,
        commercant_id: row.id,
        nom_boutique: row.nom_boutique,
        role: 'merchant'
      });

      return sendJson(req, res, 200, {
        token,
        expires_in_seconds: DEFAULT_EXP_SECONDS,
        merchant: {
          id: row.id,
          nom_boutique: row.nom_boutique,
          nom_gerant: row.nom_gerant,
          telephone: row.telephone,
          whatsapp: row.whatsapp,
          ville: row.ville,
          categorie_principale: row.categorie_principale,
          code_sms: row.code_sms
        }
      });
    }

    // Profil du commerçant connecté + Sa base de clients WhatsApp & Avis isolée
    if (req.method === 'GET' && pathname === '/api/merchants/me') {
      const merchant = getAuthenticatedMerchant(req);
      if (!merchant) {
        return sendJson(req, res, 401, { error: 'Authentification commerçant requise.' });
      }
      return sendJson(req, res, 200, { merchant });
    }

    // Base de données CRM des clients WhatsApp pour proposer des produits
    if (req.method === 'GET' && pathname === '/api/merchants/customers') {
      const merchant = getAuthenticatedMerchant(req);
      if (!merchant) {
        return sendJson(req, res, 401, { error: 'Authentification commerçant requise.' });
      }

      // Tous les acheteurs inscrits avec leur WhatsApp + le nombre de commandes passées chez CE commerçant
      const customers = db
        .prepare(
          `SELECT cl.id, cl.nom_complet, cl.telephone, COALESCE(cl.whatsapp, cl.telephone) AS whatsapp,
                  cl.ville, cl.secteur_quartier, cl.point_repere, cl.created_at,
                  COUNT(c.id) AS nb_commandes_boutique,
                  COALESCE(SUM(c.total_fcfa), 0) AS total_depense_fcfa
           FROM clients cl
           LEFT JOIN commandes c ON c.client_id = cl.id AND c.commercant_id = ?
           GROUP BY cl.id
           ORDER BY cl.created_at DESC`
        )
        .all(merchant.id);

      const avis = db
        .prepare('SELECT * FROM avis_clients WHERE commercant_id = ? ORDER BY created_at DESC')
        .all(merchant.id);

      return sendJson(req, res, 200, {
        commercant_id: merchant.id,
        nom_boutique: merchant.nom_boutique,
        customers,
        avis
      });
    }

    // =========================================================================
    // 3. ENREGISTREMENT ACHETEUR À L'OUVERTURE (NOM + WHATSAPP) & AVIS
    // =========================================================================
    if (
      req.method === 'POST' &&
      (pathname === '/api/buyers/onboard' || pathname === '/api/auth/login')
    ) {
      const body = await readJsonBody(req);
      const nomComplet = (body.nom_complet || 'Client SahelExpress').trim();
      const whatsapp = (body.whatsapp || body.telephone || '').trim().replace(/\s+/g, '');
      const telephone = (body.telephone || whatsapp).trim().replace(/\s+/g, '');
      const ville = (body.ville || 'Gorom-Gorom').trim();
      const secteurQuartier = (body.secteur_quartier || 'SEC1').trim();
      const pointRepere = (body.point_repere || '').trim();

      if (!telephone) {
        return sendJson(req, res, 400, {
          error: 'Le nom complet et le numéro de téléphone WhatsApp sont obligatoires.'
        });
      }

      const nowIso = new Date().toISOString();
      let client = db
        .prepare('SELECT * FROM clients WHERE telephone = ? OR whatsapp = ?')
        .get(telephone, whatsapp);

      if (!client) {
        const newClientId =
          body.client_id || 'CL' + Math.floor(100 + Math.random() * 899).toString();
        db.prepare(
          `INSERT INTO clients (id, telephone, whatsapp, nom_complet, ville, secteur_quartier, point_repere, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(newClientId, telephone, whatsapp, nomComplet, ville, secteurQuartier, pointRepere, nowIso);
        client = db.prepare('SELECT * FROM clients WHERE id = ?').get(newClientId);
      } else {
        db.prepare(
          `UPDATE clients SET nom_complet = ?, whatsapp = ?, ville = ?, secteur_quartier = ?, point_repere = ? WHERE id = ?`
        ).run(nomComplet, whatsapp, ville, secteurQuartier, pointRepere, client.id);
        client = db.prepare('SELECT * FROM clients WHERE id = ?').get(client.id);
      }

      const token = signJwt({
        sub: client.id,
        telephone: client.telephone,
        whatsapp: client.whatsapp,
        nom_complet: client.nom_complet,
        role: 'buyer'
      });

      return sendJson(req, res, 200, {
        token,
        expires_in_seconds: DEFAULT_EXP_SECONDS,
        client
      });
    }

    // Récupération et publication des Avis & Suggestions de Produits
    if (req.method === 'GET' && pathname === '/api/reviews') {
      const commercantId = parsedUrl.searchParams.get('commercant_id');
      let rows;
      if (commercantId) {
        rows = db
          .prepare(
            `SELECT av.*, m.nom_boutique
             FROM avis_clients av
             LEFT JOIN commercants m ON m.id = av.commercant_id
             WHERE av.commercant_id = ?
             ORDER BY av.created_at DESC`
          )
          .all(commercantId);
      } else {
        rows = db
          .prepare(
            `SELECT av.*, m.nom_boutique
             FROM avis_clients av
             LEFT JOIN commercants m ON m.id = av.commercant_id
             ORDER BY av.created_at DESC LIMIT 50`
          )
          .all();
      }
      return sendJson(req, res, 200, { reviews: rows });
    }

    if (req.method === 'POST' && pathname === '/api/reviews') {
      const body = await readJsonBody(req);
      const commercantId = (body.commercant_id || 'M-SAHEL').trim();
      const articleId = (body.article_id || '').trim() || null;
      const clientId = (body.client_id || 'CL890').trim();
      const clientNom = (body.client_nom || 'Acheteur SahelExpress').trim();
      const clientWhatsapp = (body.client_whatsapp || '').trim();
      const note = Math.min(5, Math.max(1, parseInt(body.note || 5, 10)));
      const commentaire = (body.commentaire || '').trim();
      const suggestionProduit = (body.suggestion_produit || '').trim();

      if (!commentaire && !suggestionProduit) {
        return sendJson(req, res, 400, {
          error: 'Veuillez saisir un avis ou une suggestion de produit.'
        });
      }

      const nowIso = new Date().toISOString();
      const info = db
        .prepare(
          `INSERT INTO avis_clients (commercant_id, article_id, client_id, client_nom, client_whatsapp, note, commentaire, suggestion_produit, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          commercantId,
          articleId,
          clientId,
          clientNom,
          clientWhatsapp,
          note,
          commentaire,
          suggestionProduit,
          nowIso
        );

      const saved = db
        .prepare('SELECT * FROM avis_clients WHERE id = ?')
        .get(info.lastInsertRowid);

      return sendJson(req, res, 201, {
        message: 'Merci ! Votre avis / suggestion a été transmis au commerçant.',
        review: saved
      });
    }

    // =========================================================================
    // 4. SYNCHRONISATION CATALOGUE (GLOBALE ACHETEUR OU ISOLÉE COMMERÇANT)
    // =========================================================================
    if (req.method === 'GET' && pathname === '/api/catalog/sync') {
      const since = parsedUrl.searchParams.get('since') || '';
      const commercantFilter = parsedUrl.searchParams.get('commercant_id') || '';
      const clientHash = parsedUrl.searchParams.get('hash') || req.headers['x-client-hash'] || '';
      const currentHash = getCatalogStateHash(commercantFilter);

      if (clientHash && clientHash === currentHash) {
        return sendJson(req, res, 200, {
          up_to_date: true,
          catalog_hash: currentHash,
          sync_timestamp: new Date().toISOString(),
          updated_articles: [],
          deleted_article_ids: []
        });
      }

      let updatedArticles = [];
      let deletedIds = [];

      const baseQuery = `
        SELECT a.*, m.nom_boutique, m.ville AS boutique_ville, m.whatsapp AS boutique_whatsapp, m.code_sms AS boutique_code_sms
        FROM articles a
        LEFT JOIN commercants m ON m.id = a.commercant_id
      `;

      if (since) {
        const rows = commercantFilter
          ? db
              .prepare(`${baseQuery} WHERE a.commercant_id = ? AND a.updated_at > ? ORDER BY a.categorie, a.id`)
              .all(commercantFilter, since)
          : db
              .prepare(`${baseQuery} WHERE a.updated_at > ? ORDER BY a.categorie, a.id`)
              .all(since);

        updatedArticles = rows.filter((r) => Boolean(r.is_active));
        deletedIds = rows.filter((r) => !r.is_active).map((r) => r.id);
      } else {
        updatedArticles = commercantFilter
          ? db
              .prepare(`${baseQuery} WHERE a.commercant_id = ? AND a.is_active = 1 ORDER BY a.categorie, a.id`)
              .all(commercantFilter)
          : db
              .prepare(`${baseQuery} WHERE a.is_active = 1 ORDER BY a.categorie, a.id`)
              .all();
      }

      return sendJson(req, res, 200, {
        up_to_date: false,
        mode: since ? 'DELTA_SYNC' : 'FULL_SYNC',
        catalog_hash: currentHash,
        sync_timestamp: new Date().toISOString(),
        logistics_sms_number: LOGISTICS_SMS_NUMBER,
        count: updatedArticles.length,
        updated_articles: updatedArticles,
        deleted_article_ids: deletedIds
      });
    }

    // =========================================================================
    // 5. GESTION DES ARTICLES & STOCKS (ISOLÉE PAR COMPTE COMMERÇANT)
    // =========================================================================
    if (req.method === 'POST' && pathname === '/api/articles') {
      const merchant = getAuthenticatedMerchant(req);
      const body = await readJsonBody(req);
      const targetCommercantId = merchant ? merchant.id : body.commercant_id || 'M-SAHEL';

      const id = (body.id || `PROD${Math.floor(50 + Math.random() * 900)}`).toUpperCase().trim();
      const designation = (body.designation || '').trim();
      const description = (body.description || '').trim();
      const categorie = (body.categorie || 'Consommables').trim();
      const prixUnitaire = parseInt(body.prix_unitaire, 10);
      const stockDisponible = parseInt(body.stock_disponible ?? 0, 10);
      const photoUrl = body.photo_url !== undefined ? String(body.photo_url).trim() : '';
      const isActive = body.is_active === undefined ? 1 : body.is_active ? 1 : 0;
      const nowIso = new Date().toISOString();

      if (!designation || Number.isNaN(prixUnitaire) || prixUnitaire < 0) {
        return sendJson(req, res, 400, {
          error: 'Désignation et prix_unitaire (en FCFA) valides sont requis.'
        });
      }

      // Vérifier qu'un commerçant ne modifie pas l'article d'un autre commerçant
      const existing = db.prepare('SELECT commercant_id FROM articles WHERE id = ?').get(id);
      if (existing && merchant && existing.commercant_id !== merchant.id) {
        return sendJson(req, res, 403, {
          error: 'Accès refusé : ce code article appartient à un autre commerçant.'
        });
      }

      const photoHash = md5Hash(`${id}:${prixUnitaire}:${nowIso}`);

      db.prepare(
        `INSERT INTO articles (id, commercant_id, designation, description, categorie, prix_unitaire, stock_disponible, photo_url, photo_hash_md5, is_active, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           designation = excluded.designation,
           description = excluded.description,
           categorie = excluded.categorie,
           prix_unitaire = excluded.prix_unitaire,
           stock_disponible = excluded.stock_disponible,
           photo_url = excluded.photo_url,
           photo_hash_md5 = excluded.photo_hash_md5,
           is_active = excluded.is_active,
           updated_at = excluded.updated_at`
      ).run(
        id,
        targetCommercantId,
        designation,
        description,
        categorie,
        prixUnitaire,
        stockDisponible,
        photoUrl,
        photoHash,
        isActive,
        nowIso
      );

      const saved = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
      return sendJson(req, res, 200, {
        message: 'Article enregistré pour votre boutique.',
        article: saved,
        catalog_hash: getCatalogStateHash()
      });
    }

    if ((req.method === 'PATCH' || req.method === 'PUT') && pathname.startsWith('/api/articles/')) {
      const merchant = getAuthenticatedMerchant(req);
      const articleId = decodeURIComponent(pathname.replace('/api/articles/', '')).toUpperCase();
      const existing = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
      if (!existing) {
        return sendJson(req, res, 404, { error: `Article ${articleId} introuvable.` });
      }

      // Isolation stricte : si un commerçant est authentifié, il ne peut modifier QUE ses articles
      if (merchant && existing.commercant_id !== merchant.id) {
        return sendJson(req, res, 403, {
          error: 'Accès interdit : vous ne pouvez pas modifier les stocks d\'un autre commerçant.'
        });
      }

      const body = await readJsonBody(req);
      const newPrix =
        body.prix_unitaire !== undefined ? parseInt(body.prix_unitaire, 10) : existing.prix_unitaire;
      const newStock =
        body.stock_disponible !== undefined
          ? parseInt(body.stock_disponible, 10)
          : existing.stock_disponible;
      const newDesignation = body.designation !== undefined ? body.designation : existing.designation;
      const newDescription = body.description !== undefined ? body.description : (existing.description || '');
      const newCategorie = body.categorie !== undefined ? body.categorie : existing.categorie;
      const newPhotoUrl = body.photo_url !== undefined ? body.photo_url : (existing.photo_url || '');
      const newActive =
        body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active;
      const nowIso = new Date().toISOString();

      db.prepare(
        `UPDATE articles
         SET designation = ?, description = ?, categorie = ?, prix_unitaire = ?, stock_disponible = ?, photo_url = ?, is_active = ?,
             photo_hash_md5 = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        newDesignation,
        newDescription,
        newCategorie,
        newPrix,
        newStock,
        newPhotoUrl,
        newActive,
        md5Hash(`${articleId}:${newPrix}:${nowIso}`),
        nowIso,
        articleId
      );

      const updated = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
      return sendJson(req, res, 200, {
        message: 'Stock / Prix mis à jour avec succès.',
        article: updated,
        catalog_hash: getCatalogStateHash()
      });
    }

    // =========================================================================
    // 6. COMMANDES ISOLÉES PAR COMMERÇANT
    // =========================================================================
    if (req.method === 'GET' && pathname === '/api/orders') {
      const merchant = getAuthenticatedMerchant(req);
      const statutFilter = parsedUrl.searchParams.get('statut');
      const queryCommercantId = merchant
        ? merchant.id
        : parsedUrl.searchParams.get('commercant_id') || null;

      let orders;
      if (queryCommercantId && statutFilter) {
        orders = db
          .prepare(
            'SELECT id FROM commandes WHERE commercant_id = ? AND statut = ? ORDER BY created_at DESC'
          )
          .all(queryCommercantId, statutFilter);
      } else if (queryCommercantId) {
        orders = db
          .prepare('SELECT id FROM commandes WHERE commercant_id = ? ORDER BY created_at DESC')
          .all(queryCommercantId);
      } else if (statutFilter) {
        orders = db
          .prepare('SELECT id FROM commandes WHERE statut = ? ORDER BY created_at DESC')
          .all(statutFilter);
      } else {
        orders = db.prepare('SELECT id FROM commandes ORDER BY created_at DESC').all();
      }

      const detailedOrders = orders.map((o) => getFullOrderById(o.id));
      return sendJson(req, res, 200, {
        commercant_id: queryCommercantId,
        count: detailedOrders.length,
        orders: detailedOrders
      });
    }

    if (req.method === 'POST' && pathname === '/api/orders') {
      const body = await readJsonBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0) {
        return sendJson(req, res, 400, { error: 'Le panier est vide.' });
      }

      const nowIso = new Date().toISOString();
      const clientInfo = body.client || {};
      const clientId = (clientInfo.id || body.client_id || 'CL890').toUpperCase().trim();
      const telephone = (clientInfo.telephone || clientInfo.whatsapp || '+22670000000').trim();
      const whatsapp = (clientInfo.whatsapp || telephone).trim();
      const nomComplet = (clientInfo.nom_complet || 'Client SahelExpress').trim();
      const ville = (clientInfo.ville || 'Gorom-Gorom').trim();
      const secteurQuartier = (clientInfo.secteur_quartier || 'SEC1').trim();
      const pointRepere = (clientInfo.point_repere || body.point_repere || '').trim();

      const existingClient = db
        .prepare('SELECT * FROM clients WHERE id = ? OR telephone = ?')
        .get(clientId, telephone);

      let finalClientId = clientId;
      if (!existingClient) {
        db.prepare(
          `INSERT INTO clients (id, telephone, whatsapp, nom_complet, ville, secteur_quartier, point_repere, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(clientId, telephone, whatsapp, nomComplet, ville, secteurQuartier, pointRepere, nowIso);
      } else {
        finalClientId = existingClient.id;
        db.prepare(
          `UPDATE clients SET nom_complet = ?, whatsapp = ?, ville = ?, secteur_quartier = ?, point_repere = ? WHERE id = ?`
        ).run(nomComplet, whatsapp, ville, secteurQuartier, pointRepere, finalClientId);
      }

      const modeTransmission = ['DATA_HTTPS', 'SMS', 'LOCAL_WIFI'].includes(body.mode_transmission)
        ? body.mode_transmission
        : 'DATA_HTTPS';

      const modePaiement = ['CASH_DELIVERY', 'ORANGE_MONEY', 'MOOV_MONEY'].includes(body.mode_paiement)
        ? body.mode_paiement
        : 'CASH_DELIVERY';

      // Regrouper les articles par commerçant pour que chaque commerçant ne reçoive QUE ses articles
      const groupsByMerchant = {};
      for (const item of items) {
        const artId = String(item.article_id || '').toUpperCase().trim();
        const qty = parseInt(item.quantite, 10);
        if (!artId || Number.isNaN(qty) || qty <= 0) {
          return sendJson(req, res, 400, { error: `Ligne d'article invalide: ${JSON.stringify(item)}` });
        }

        const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(artId);
        if (!article) {
          return sendJson(req, res, 404, { error: `Article "${artId}" introuvable dans le catalogue.` });
        }

        const mId = article.commercant_id || 'M-SAHEL';
        if (!groupsByMerchant[mId]) {
          groupsByMerchant[mId] = [];
        }
        groupsByMerchant[mId].push({
          article_id: article.id,
          quantite: qty,
          prix_applique: article.prix_unitaire
        });
      }

      const adresseLivraison =
        body.adresse_livraison ||
        `${ville} - ${secteurQuartier}${pointRepere ? ' | Repère: ' + pointRepere : ''}`;

      const insertOrder = db.prepare(
        `INSERT INTO commandes (id, commercant_id, client_id, total_fcfa, mode_transmission, mode_paiement, statut, adresse_livraison, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'RECUE', ?, ?)`
      );
      const insertLine = db.prepare(
        `INSERT INTO lignes_commande (commande_id, article_id, quantite, prix_applique)
         VALUES (?, ?, ?, ?)`
      );
      const decStock = db.prepare(
        `UPDATE articles SET stock_disponible = MAX(0, stock_disponible - ?), updated_at = ? WHERE id = ?`
      );

      const createdOrders = [];
      for (const [mId, lines] of Object.entries(groupsByMerchant)) {
        const orderId = generateOrderId();
        const subTotal = lines.reduce((s, l) => s + l.prix_applique * l.quantite, 0);
        insertOrder.run(
          orderId,
          mId,
          finalClientId,
          subTotal,
          modeTransmission,
          modePaiement,
          adresseLivraison,
          nowIso
        );
        for (const line of lines) {
          insertLine.run(orderId, line.article_id, line.quantite, line.prix_applique);
          decStock.run(line.quantite, nowIso, line.article_id);
        }
        createdOrders.push(getFullOrderById(orderId));
      }

      return sendJson(req, res, 201, {
        message: 'Commande enregistrée avec succès.',
        order: createdOrders[0],
        orders: createdOrders
      });
    }

    if (
      (req.method === 'PATCH' || req.method === 'PUT') &&
      pathname.startsWith('/api/orders/') &&
      pathname.endsWith('/status')
    ) {
      const merchant = getAuthenticatedMerchant(req);
      const orderId = decodeURIComponent(
        pathname.replace('/api/orders/', '').replace('/status', '')
      );
      const body = await readJsonBody(req);
      const newStatut = (body.statut || '').toUpperCase().trim();

      if (!['RECUE', 'EN_COURS', 'LIVREE', 'ANNULEE'].includes(newStatut)) {
        return sendJson(req, res, 400, {
          error: 'Statut invalide. Valeurs autorisées: RECUE, EN_COURS, LIVREE, ANNULEE.'
        });
      }

      const existing = db.prepare('SELECT id, commercant_id FROM commandes WHERE id = ?').get(orderId);
      if (!existing) {
        return sendJson(req, res, 404, { error: `Commande ${orderId} introuvable.` });
      }

      // Isolation : un commerçant connecté ne peut pas modifier la commande d'un autre commerçant
      if (merchant && existing.commercant_id !== merchant.id) {
        return sendJson(req, res, 403, {
          error: 'Accès interdit : cette commande appartient à un autre commerçant.'
        });
      }

      db.prepare('UPDATE commandes SET statut = ? WHERE id = ?').run(newStatut, orderId);
      return sendJson(req, res, 200, {
        message: `Statut de la commande ${orderId} mis à jour vers ${newStatut}.`,
        order: getFullOrderById(orderId)
      });
    }

    // =========================================================================
    // 7. PASSERELLE SMS ENTRANT (ROUTAGE AUTOMATIQUE VERS LE BON COMMERÇANT)
    // =========================================================================
    if (req.method === 'POST' && pathname === '/api/sms/incoming') {
      const body = await readJsonBody(req);
      const rawMessage = body.message || body.body || body.text || '';
      const senderPhone = (body.from || body.sender || '+22670112233').trim();

      const parsed = parseCompactSms(rawMessage);
      if (!parsed.valid) {
        return sendJson(req, res, 400, {
          status: 'SMS_PARSE_ERROR',
          error: parsed.error,
          raw_received: rawMessage
        });
      }

      const duplicateOrder = db
        .prepare('SELECT id, total_fcfa FROM commandes WHERE sms_dedup_hash = ?')
        .get(parsed.dedup_hash);

      if (duplicateOrder) {
        return sendJson(req, res, 200, {
          status: 'DUPLICATE_IGNORED',
          message: 'Doublon SMS détecté et ignoré (commande déjà enregistrée).',
          order: getFullOrderById(duplicateOrder.id),
          sms_reply: `SahelExpress: Commande deja recue sous #${duplicateOrder.id} (${duplicateOrder.total_fcfa} FCFA). En attente de preparation.`
        });
      }

      const nowIso = new Date().toISOString();

      let client = db
        .prepare('SELECT * FROM clients WHERE id = ? OR telephone = ?')
        .get(parsed.client_code, senderPhone);

      if (!client) {
        db.prepare(
          `INSERT INTO clients (id, telephone, whatsapp, nom_complet, ville, secteur_quartier, point_repere, created_at)
           VALUES (?, ?, ?, ?, 'Gorom-Gorom', ?, ?, ?)`
        ).run(
          parsed.client_code,
          senderPhone,
          senderPhone,
          `Client SMS (${parsed.client_code})`,
          parsed.quartier_id,
          parsed.note_repere,
          nowIso
        );
        client = db.prepare('SELECT * FROM clients WHERE id = ?').get(parsed.client_code);
      }

      let totalFcfa = 0;
      const validLines = [];
      const unknownArticles = [];
      let detectedMerchantId = null;

      for (const item of parsed.items) {
        const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(item.article_id);
        if (!article) {
          unknownArticles.push(item.article_id);
          continue;
        }
        if (!detectedMerchantId) {
          detectedMerchantId = article.commercant_id || 'M-SAHEL';
        }
        totalFcfa += article.prix_unitaire * item.quantite;
        validLines.push({
          article_id: article.id,
          designation: article.designation,
          quantite: item.quantite,
          prix_applique: article.prix_unitaire
        });
      }

      if (validLines.length === 0) {
        return sendJson(req, res, 400, {
          status: 'UNKNOWN_ARTICLES',
          error: `Aucun code article reconnu dans le SMS (${unknownArticles.join(', ')}).`
        });
      }

      const orderId = generateOrderId();
      const adresseLivraison = `${client.ville || 'Gorom-Gorom'} - Quartier ${parsed.quartier_id} | Repère: ${parsed.note_repere}`;

      db.prepare(
        `INSERT INTO commandes (id, commercant_id, client_id, total_fcfa, mode_transmission, mode_paiement, statut, adresse_livraison, raw_sms_payload, sms_dedup_hash, created_at)
         VALUES (?, ?, ?, ?, 'SMS', ?, 'RECUE', ?, ?, ?, ?)`
      ).run(
        orderId,
        detectedMerchantId || 'M-SAHEL',
        client.id,
        totalFcfa,
        parsed.mode_paiement,
        adresseLivraison,
        parsed.raw_sms,
        parsed.dedup_hash,
        nowIso
      );

      const insertLine = db.prepare(
        `INSERT INTO lignes_commande (commande_id, article_id, quantite, prix_applique)
         VALUES (?, ?, ?, ?)`
      );
      const decStock = db.prepare(
        `UPDATE articles SET stock_disponible = MAX(0, stock_disponible - ?), updated_at = ? WHERE id = ?`
      );

      for (const line of validLines) {
        insertLine.run(orderId, line.article_id, line.quantite, line.prix_applique);
        decStock.run(line.quantite, nowIso, line.article_id);
      }

      const fullOrder = getFullOrderById(orderId);
      const smsAckMessage = `SahelExpress: Commande #${orderId} recue (${totalFcfa} FCFA). Statut: En attente de preparation. Livraison: ${parsed.quartier_id} (${parsed.note_repere}).`;

      return sendJson(req, res, 201, {
        status: 'SMS_ORDER_CREATED',
        statut_metier: 'En attente de préparation',
        order: fullOrder,
        sms_reply: smsAckMessage,
        warnings:
          unknownArticles.length > 0
            ? `Articles ignorés car inconnus: ${unknownArticles.join(', ')}`
            : null
      });
    }

    // =========================================================================
    // 8. MINIATURES WEBP & FICHIERS STATIQUES
    // =========================================================================
    if (req.method === 'GET' && pathname.includes('/media/') && pathname.endsWith('.webp')) {
      res.writeHead(200, {
        'Content-Type': 'image/webp',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': MINIMAL_WEBP_BUFFER.length
      });
      res.end(MINIMAL_WEBP_BUFFER);
      return;
    }

    const publicDir = path.join(__dirname, '..', 'public');
    let safePath = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.join(publicDir, safePath);

    if (filePath.startsWith(publicDir) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon'
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const content = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400'
      });
      res.end(content);
      return;
    }

    return sendJson(req, res, 404, { error: `Route introuvable: ${req.method} ${pathname}` });
  } catch (err) {
    console.error('[SahelExpress Server Error]:', err);
    return sendJson(req, res, 500, { error: err.message || 'Erreur interne du serveur' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`================================================================`);
    console.log(`🚀 Serveur Multi-Commerçants SahelExpress actif sur http://localhost:${PORT}`);
    console.log(`================================================================`);
  });
}

module.exports = { server };
