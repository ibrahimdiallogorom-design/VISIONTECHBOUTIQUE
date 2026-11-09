/**
 * SahelExpress - Serveur Backend Résilient (API REST + Synchro Delta + Passerelle SMS + Gzip/Brotli)
 * Conforme aux Chapitres 2, 3, 4, 5 et 6 du Cahier des Charges :
 * - Compression automatique des réponses API en Brotli (`br`) ou Gzip (`gzip`)
 * - Synchronisation incrémentale du catalogue par timestamp ou hash (`GET /api/catalog/sync`)
 * - Création de commandes HTTP/Wi-Fi (`POST /api/orders`)
 * - Réception et décodage de commandes SMS (`POST /api/sms/incoming`) avec anti-doublon et accusé SMS
 * - Gestion des stocks et statuts pour le Commerçant/Livreur
 * - Authentification par token JWT longue durée (90 jours)
 */

const http = require('node:http');
const zlib = require('node:zlib');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');

const { db, md5Hash } = require('./db');
const { parseCompactSms } = require('./sms_parser');
const { signJwt, verifyJwt, DEFAULT_EXP_SECONDS } = require('./jwt');
const { buildMobileAssets } = require('./mobile_packager');

const PORT = process.env.PORT || 3000;
const LOGISTICS_SMS_NUMBER = process.env.LOGISTICS_SMS_NUMBER || '+22670001122';

// Génère automatiquement les icônes PNG 192/512 et le fichier mobile autonome au démarrage
buildMobileAssets();

/**
 * Génère une miniature WebP binaire ultra-légère (< 1 Ko, bien en dessous de la limite de 15 Ko)
 * pour garantir que chaque `/media/PRODXX.webp` réponde même hors connexion internet
 */
const MINIMAL_WEBP_BUFFER = Buffer.from(
  'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=',
  'base64'
);

/**
 * Calcule un hash global de l'état actuel du catalogue (pour la synchro incrémentale)
 */
function getCatalogStateHash() {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt, MAX(updated_at) as max_up, SUM(prix_unitaire * stock_disponible) as checksum
       FROM articles`
    )
    .get();
  return md5Hash(`${row.cnt}|${row.max_up}|${row.checksum}`);
}

/**
 * Envoie une réponse JSON compressée en Brotli ou Gzip selon l'en-tête Accept-Encoding du client
 * (Chapitre 6.3 : "Les payloads API doivent être encodés en gzip / brotli")
 */
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

/**
 * Lecture du corps JSON d'une requête HTTP
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > 1024 * 1024) {
        reject(new Error('Payload trop volumineux (> 1 Mo)'));
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
      } catch (err) {
        reject(new Error('JSON malformé'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Récupère une commande complète avec les informations client et ses lignes d'articles
 */
function getFullOrderById(orderId) {
  const order = db
    .prepare(
      `SELECT c.*,
              cl.nom_complet AS client_nom,
              cl.telephone AS client_telephone,
              cl.ville AS client_ville,
              cl.secteur_quartier AS client_secteur,
              cl.point_repere AS client_repere
       FROM commandes c
       LEFT JOIN clients cl ON cl.id = c.client_id
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

/**
 * Génère un identifiant de commande lisible et unique (ex: CMD-2026-4821)
 */
function generateOrderId() {
  const rand = Math.floor(1000 + Math.random() * 9000);
  const ts = Date.now().toString(36).slice(-3).toUpperCase();
  return `CMD-${ts}-${rand}`;
}

/**
 * Création du serveur HTTP principal
 */
const server = http.createServer(async (req, res) => {
  // Préflight CORS
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
    // 1. HEALTHCHECK & INFOS SYSTÈME
    // =========================================================================
    if (req.method === 'GET' && pathname === '/api/health') {
      const catalogHash = getCatalogStateHash();
      const articlesCount = db.prepare('SELECT COUNT(*) as c FROM articles WHERE is_active = 1').get().c;
      const ordersCount = db.prepare('SELECT COUNT(*) as c FROM commandes').get().c;

      return sendJson(req, res, 200, {
        status: 'OK',
        service: 'SahelExpress Backend API',
        region: 'Sahel & Liptako (Gorom-Gorom / Dori / Sebba)',
        logistics_sms_number: LOGISTICS_SMS_NUMBER,
        catalog_hash: catalogHash,
        stats: {
          active_articles: articlesCount,
          total_orders: ordersCount
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
        standalone_download: '/SahelExpress-Mobile-Offline.html',
        install_page: '/install.html'
      });
    }

    // =========================================================================
    // 2. AUTHENTIFICATION PAR TOKEN JWT LONGUE DURÉE (Chapitre 6.3)
    // =========================================================================
    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await readJsonBody(req);
      const telephone = (body.telephone || '').trim();
      const nomComplet = (body.nom_complet || 'Client SahelExpress').trim();
      const ville = (body.ville || 'Gorom-Gorom').trim();
      const secteurQuartier = (body.secteur_quartier || 'SEC1').trim();
      const pointRepere = (body.point_repere || '').trim();
      const role = body.role === 'merchant' ? 'merchant' : 'buyer';

      if (!telephone) {
        return sendJson(req, res, 400, { error: 'Le numéro de téléphone est obligatoire.' });
      }

      // Recherche ou création automatique du client en base
      let client = db.prepare('SELECT * FROM clients WHERE telephone = ?').get(telephone);
      if (!client) {
        const newClientId =
          body.client_id ||
          'CL' + Math.floor(100 + Math.random() * 899).toString();
        const nowIso = new Date().toISOString();

        db.prepare(
          `INSERT INTO clients (id, telephone, nom_complet, ville, secteur_quartier, point_repere, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(newClientId, telephone, nomComplet, ville, secteurQuartier, pointRepere, nowIso);

        client = db.prepare('SELECT * FROM clients WHERE id = ?').get(newClientId);
      }

      const token = signJwt({
        sub: client.id,
        telephone: client.telephone,
        nom_complet: client.nom_complet,
        role
      });

      return sendJson(req, res, 200, {
        token,
        expires_in_seconds: DEFAULT_EXP_SECONDS,
        client
      });
    }

    // =========================================================================
    // 3. SYNCHRONISATION INCRÉMENTALE DU CATALOGUE (Chapitre 3.1)
    // =========================================================================
    if (req.method === 'GET' && pathname === '/api/catalog/sync') {
      const since = parsedUrl.searchParams.get('since') || '';
      const clientHash = parsedUrl.searchParams.get('hash') || req.headers['x-client-hash'] || '';
      const currentHash = getCatalogStateHash();

      // Si le client possède déjà exactement le même hash de catalogue, 0 donnée à transférer
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

      if (since) {
        // Synchronisation par delta : uniquement les articles modifiés depuis `since`
        const rows = db
          .prepare('SELECT * FROM articles WHERE updated_at > ? ORDER BY categorie, id')
          .all(since);

        updatedArticles = rows.filter((r) => Boolean(r.is_active));
        deletedIds = rows.filter((r) => !r.is_active).map((r) => r.id);
      } else {
        // Premier chargement complet
        updatedArticles = db
          .prepare('SELECT * FROM articles WHERE is_active = 1 ORDER BY categorie, id')
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
    // 4. GESTION DU CATALOGUE & MISE À JOUR DES STOCKS (Chapitre 5.2)
    // =========================================================================
    if (req.method === 'POST' && pathname === '/api/articles') {
      const body = await readJsonBody(req);
      const id = (body.id || `PROD${Math.floor(50 + Math.random() * 900)}`).toUpperCase().trim();
      const designation = (body.designation || '').trim();
      const categorie = (body.categorie || 'Consommables').trim();
      const prixUnitaire = parseInt(body.prix_unitaire, 10);
      const stockDisponible = parseInt(body.stock_disponible ?? 0, 10);
      const photoUrl = body.photo_url || `/media/${id}.webp`;
      const isActive = body.is_active === undefined ? 1 : body.is_active ? 1 : 0;
      const nowIso = new Date().toISOString();

      if (!designation || Number.isNaN(prixUnitaire) || prixUnitaire < 0) {
        return sendJson(req, res, 400, {
          error: 'Désignation et prix_unitaire (en FCFA) valides sont requis.'
        });
      }

      const photoHash = md5Hash(`${id}:${prixUnitaire}:${nowIso}`);

      db.prepare(
        `INSERT INTO articles (id, designation, categorie, prix_unitaire, stock_disponible, photo_url, photo_hash_md5, is_active, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           designation = excluded.designation,
           categorie = excluded.categorie,
           prix_unitaire = excluded.prix_unitaire,
           stock_disponible = excluded.stock_disponible,
           photo_url = excluded.photo_url,
           photo_hash_md5 = excluded.photo_hash_md5,
           is_active = excluded.is_active,
           updated_at = excluded.updated_at`
      ).run(id, designation, categorie, prixUnitaire, stockDisponible, photoUrl, photoHash, isActive, nowIso);

      const saved = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
      return sendJson(req, res, 200, {
        message: 'Article enregistré et horodaté pour la synchronisation delta.',
        article: saved,
        catalog_hash: getCatalogStateHash()
      });
    }

    if ((req.method === 'PATCH' || req.method === 'PUT') && pathname.startsWith('/api/articles/')) {
      const articleId = decodeURIComponent(pathname.replace('/api/articles/', '')).toUpperCase();
      const existing = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
      if (!existing) {
        return sendJson(req, res, 404, { error: `Article ${articleId} introuvable.` });
      }

      const body = await readJsonBody(req);
      const newPrix =
        body.prix_unitaire !== undefined ? parseInt(body.prix_unitaire, 10) : existing.prix_unitaire;
      const newStock =
        body.stock_disponible !== undefined
          ? parseInt(body.stock_disponible, 10)
          : existing.stock_disponible;
      const newDesignation = body.designation !== undefined ? body.designation : existing.designation;
      const newCategorie = body.categorie !== undefined ? body.categorie : existing.categorie;
      const newActive =
        body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active;
      const nowIso = new Date().toISOString();

      db.prepare(
        `UPDATE articles
         SET designation = ?, categorie = ?, prix_unitaire = ?, stock_disponible = ?, is_active = ?,
             photo_hash_md5 = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        newDesignation,
        newCategorie,
        newPrix,
        newStock,
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
    // 5. COMMANDES EN LIGNE / WI-FI LOCAL (Chapitre 5.1 & 5.2)
    // =========================================================================
    if (req.method === 'GET' && pathname === '/api/orders') {
      const statutFilter = parsedUrl.searchParams.get('statut');
      let orders;
      if (statutFilter) {
        orders = db
          .prepare('SELECT id FROM commandes WHERE statut = ? ORDER BY created_at DESC')
          .all(statutFilter);
      } else {
        orders = db.prepare('SELECT id FROM commandes ORDER BY created_at DESC').all();
      }

      const detailedOrders = orders.map((o) => getFullOrderById(o.id));
      return sendJson(req, res, 200, {
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
      const telephone = (clientInfo.telephone || '+22670000000').trim();
      const nomComplet = (clientInfo.nom_complet || 'Client SahelExpress').trim();
      const ville = (clientInfo.ville || 'Gorom-Gorom').trim();
      const secteurQuartier = (clientInfo.secteur_quartier || 'SEC1').trim();
      const pointRepere = (clientInfo.point_repere || body.point_repere || '').trim();

      // S'assurer que le client existe dans la table `clients`
      const existingClient = db
        .prepare('SELECT * FROM clients WHERE id = ? OR telephone = ?')
        .get(clientId, telephone);

      let finalClientId = clientId;
      if (!existingClient) {
        db.prepare(
          `INSERT INTO clients (id, telephone, nom_complet, ville, secteur_quartier, point_repere, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(clientId, telephone, nomComplet, ville, secteurQuartier, pointRepere, nowIso);
      } else {
        finalClientId = existingClient.id;
        db.prepare(
          `UPDATE clients SET nom_complet = ?, ville = ?, secteur_quartier = ?, point_repere = ? WHERE id = ?`
        ).run(nomComplet, ville, secteurQuartier, pointRepere, finalClientId);
      }

      const modeTransmission = ['DATA_HTTPS', 'SMS', 'LOCAL_WIFI'].includes(body.mode_transmission)
        ? body.mode_transmission
        : 'DATA_HTTPS';

      const modePaiement = ['CASH_DELIVERY', 'ORANGE_MONEY', 'MOOV_MONEY'].includes(body.mode_paiement)
        ? body.mode_paiement
        : 'CASH_DELIVERY';

      // Calcul du total officiel en FCFA et vérification des articles
      let totalFcfa = 0;
      const validatedLines = [];

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

        const lineTotal = article.prix_unitaire * qty;
        totalFcfa += lineTotal;
        validatedLines.push({
          article_id: article.id,
          quantite: qty,
          prix_applique: article.prix_unitaire
        });
      }

      const orderId = generateOrderId();
      const adresseLivraison =
        body.adresse_livraison ||
        `${ville} - ${secteurQuartier}${pointRepere ? ' | Repère: ' + pointRepere : ''}`;

      db.prepare(
        `INSERT INTO commandes (id, client_id, total_fcfa, mode_transmission, mode_paiement, statut, adresse_livraison, created_at)
         VALUES (?, ?, ?, ?, ?, 'RECUE', ?, ?)`
      ).run(orderId, finalClientId, totalFcfa, modeTransmission, modePaiement, adresseLivraison, nowIso);

      const insertLine = db.prepare(
        `INSERT INTO lignes_commande (commande_id, article_id, quantite, prix_applique)
         VALUES (?, ?, ?, ?)`
      );
      const decStock = db.prepare(
        `UPDATE articles SET stock_disponible = MAX(0, stock_disponible - ?), updated_at = ? WHERE id = ?`
      );

      for (const line of validatedLines) {
        insertLine.run(orderId, line.article_id, line.quantite, line.prix_applique);
        decStock.run(line.quantite, nowIso, line.article_id);
      }

      const createdOrder = getFullOrderById(orderId);
      return sendJson(req, res, 201, {
        message: 'Commande enregistrée avec succès.',
        order: createdOrder
      });
    }

    // Mise à jour du statut d'une commande (RECUE -> EN_COURS -> LIVREE / ANNULEE)
    if (
      (req.method === 'PATCH' || req.method === 'PUT') &&
      pathname.startsWith('/api/orders/') &&
      pathname.endsWith('/status')
    ) {
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

      const existing = db.prepare('SELECT id FROM commandes WHERE id = ?').get(orderId);
      if (!existing) {
        return sendJson(req, res, 404, { error: `Commande ${orderId} introuvable.` });
      }

      db.prepare('UPDATE commandes SET statut = ? WHERE id = ?').run(newStatut, orderId);
      return sendJson(req, res, 200, {
        message: `Statut de la commande ${orderId} mis à jour vers ${newStatut}.`,
        order: getFullOrderById(orderId)
      });
    }

    // =========================================================================
    // 6. PASSERELLE SMS ENTRANT & DÉCODAGE AUTOMATIQUE (Chapitre 3.2 & 6.4)
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

      // Vérification anti-doublon (Chapitre 6.4 : "gérer les éventuels doublons de SMS d'une même commande")
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

      // Recherche ou création du client à partir du CODE_CLIENT ou du numéro expéditeur
      let client = db
        .prepare('SELECT * FROM clients WHERE id = ? OR telephone = ?')
        .get(parsed.client_code, senderPhone);

      if (!client) {
        db.prepare(
          `INSERT INTO clients (id, telephone, nom_complet, ville, secteur_quartier, point_repere, created_at)
           VALUES (?, ?, ?, 'Gorom-Gorom', ?, ?, ?)`
        ).run(
          parsed.client_code,
          senderPhone,
          `Client SMS (${parsed.client_code})`,
          parsed.quartier_id,
          parsed.note_repere,
          nowIso
        );
        client = db.prepare('SELECT * FROM clients WHERE id = ?').get(parsed.client_code);
      }

      // Vérification des articles et calcul du montant total en FCFA
      let totalFcfa = 0;
      const validLines = [];
      const unknownArticles = [];

      for (const item of parsed.items) {
        const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(item.article_id);
        if (!article) {
          unknownArticles.push(item.article_id);
          continue;
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
        `INSERT INTO commandes (id, client_id, total_fcfa, mode_transmission, mode_paiement, statut, adresse_livraison, raw_sms_payload, sms_dedup_hash, created_at)
         VALUES (?, ?, ?, 'SMS', ?, 'RECUE', ?, ?, ?, ?)`
      ).run(
        orderId,
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
    // 7. MINIATURES WEBP LOCALES (< 15 Ko) & FICHIERS STATIQUES FRONT-END
    // =========================================================================
    if (req.method === 'GET' && pathname.startsWith('/media/') && pathname.endsWith('.webp')) {
      res.writeHead(200, {
        'Content-Type': 'image/webp',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': MINIMAL_WEBP_BUFFER.length
      });
      res.end(MINIMAL_WEBP_BUFFER);
      return;
    }

    // Service des fichiers statiques du dossier `public/` (pour l'étape suivante : PWA)
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
    console.log(`🚀 Serveur Backend SahelExpress actif sur http://localhost:${PORT}`);
    console.log(`📡 Passerelle SMS Webhook : POST http://localhost:${PORT}/api/sms/incoming`);
    console.log(`🔄 Synchro Catalogue Delta : GET  http://localhost:${PORT}/api/catalog/sync`);
    console.log(`================================================================`);
  });
}

module.exports = { server };
