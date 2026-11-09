/**
 * SahelExpress - Module Base de Données Relationnelle (SQLite Natif Node.js 24)
 * Conforme au Chapitre 4 du Cahier des Charges :
 * - TABLE clients
 * - TABLE articles
 * - TABLE commandes
 * - TABLE lignes_commande
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'sahelexpress.db');
const db = new DatabaseSync(DB_PATH);

// Optimisations SQLite pour performance et intégrité référentielle
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA synchronous = NORMAL;');

/**
 * Initialisation du schéma relationnel exact de la fiche technique
 */
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id VARCHAR(36) PRIMARY KEY,
      telephone VARCHAR(20) UNIQUE NOT NULL,
      nom_complet VARCHAR(100),
      ville VARCHAR(50) DEFAULT 'Gorom-Gorom',
      secteur_quartier VARCHAR(100),
      point_repere TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS articles (
      id VARCHAR(20) PRIMARY KEY,
      designation VARCHAR(150) NOT NULL,
      categorie VARCHAR(50),
      prix_unitaire INTEGER NOT NULL,
      stock_disponible INTEGER DEFAULT 0,
      photo_url VARCHAR(255),
      photo_hash_md5 VARCHAR(32),
      is_active BOOLEAN DEFAULT 1,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS commandes (
      id VARCHAR(36) PRIMARY KEY,
      client_id VARCHAR(36) REFERENCES clients(id),
      total_fcfa INTEGER NOT NULL,
      mode_transmission VARCHAR(10) CHECK (mode_transmission IN ('DATA_HTTPS', 'SMS', 'LOCAL_WIFI')),
      mode_paiement VARCHAR(20) CHECK (mode_paiement IN ('CASH_DELIVERY', 'ORANGE_MONEY', 'MOOV_MONEY')),
      statut VARCHAR(20) DEFAULT 'RECUE',
      adresse_livraison TEXT,
      raw_sms_payload TEXT,
      sms_dedup_hash VARCHAR(64),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS lignes_commande (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      commande_id VARCHAR(36) REFERENCES commandes(id) ON DELETE CASCADE,
      article_id VARCHAR(20) REFERENCES articles(id),
      quantite INTEGER NOT NULL,
      prix_applique INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_articles_updated_at ON articles(updated_at);
    CREATE INDEX IF NOT EXISTS idx_commandes_created_at ON commandes(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_commandes_dedup ON commandes(sms_dedup_hash);
  `);
}

/**
 * Génère un hash MD5 court pour vérifier l'intégrité des miniatures
 */
function md5Hash(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * Peuple la base avec un catalogue réaliste adapté au Sahel & Liptako
 * (Gorom-Gorom, Dori, Sebba, Markoye) et aux 5 catégories officielles :
 * - Quincaillerie
 * - Petit électroménager
 * - Solaire
 * - Consommables
 * - Papeterie
 */
function seedInitialData() {
  const countRow = db.prepare('SELECT COUNT(*) as total FROM articles').get();
  if (countRow && countRow.total > 0) {
    return;
  }

  const nowIso = new Date().toISOString();

  const initialArticles = [
    // Catégorie : Solaire
    {
      id: 'PROD01',
      designation: 'Kit Solaire Domestique 50W + Batterie Lithium + 3 Lampes LED',
      categorie: 'Solaire',
      prix_unitaire: 32500,
      stock_disponible: 25,
      photo_url: '/media/PROD01.webp'
    },
    {
      id: 'PROD02',
      designation: 'Lampe Torche Solaire Rechargeable + Port USB Powerbank',
      categorie: 'Solaire',
      prix_unitaire: 4500,
      stock_disponible: 80,
      photo_url: '/media/PROD02.webp'
    },
    {
      id: 'PROD03',
      designation: 'Panneau Solaire Monocristallin 150W 12V Haute Résilience',
      categorie: 'Solaire',
      prix_unitaire: 48000,
      stock_disponible: 14,
      photo_url: '/media/PROD03.webp'
    },

    // Catégorie : Consommables
    {
      id: 'PROD10',
      designation: 'Sac de Riz Brisure Parfumé 25 Kg',
      categorie: 'Consommables',
      prix_unitaire: 12500,
      stock_disponible: 120,
      photo_url: '/media/PROD10.webp'
    },
    {
      id: 'PROD11',
      designation: 'Bidon Huile Alimentaire 5 Litres',
      categorie: 'Consommables',
      prix_unitaire: 5500,
      stock_disponible: 65,
      photo_url: '/media/PROD11.webp'
    },
    {
      id: 'PROD12',
      designation: 'Carton de Savon de Ménage Local (24 Barres)',
      categorie: 'Consommables',
      prix_unitaire: 6000,
      stock_disponible: 50,
      photo_url: '/media/PROD12.webp'
    },

    // Catégorie : Quincaillerie
    {
      id: 'PROD20',
      designation: 'Cadenas Acier Blindé Anti-Poussière 60mm',
      categorie: 'Quincaillerie',
      prix_unitaire: 2500,
      stock_disponible: 90,
      photo_url: '/media/PROD20.webp'
    },
    {
      id: 'PROD21',
      designation: 'Brouette Renforcée Chantier Cuve Galvanisée 90L',
      categorie: 'Quincaillerie',
      prix_unitaire: 24000,
      stock_disponible: 18,
      photo_url: '/media/PROD21.webp'
    },
    {
      id: 'PROD22',
      designation: 'Caisse à Outils Métallique Complète (32 Pièces)',
      categorie: 'Quincaillerie',
      prix_unitaire: 18500,
      stock_disponible: 22,
      photo_url: '/media/PROD22.webp'
    },

    // Catégorie : Petit électroménager
    {
      id: 'PROD30',
      designation: 'Ventilateur Rechargeable 12V Solaire/Secteur Autonomie 10h',
      categorie: 'Petit électroménager',
      prix_unitaire: 21000,
      stock_disponible: 30,
      photo_url: '/media/PROD30.webp'
    },
    {
      id: 'PROD31',
      designation: 'Bouilloire Électrique Inox Basse Consommation 1.8L',
      categorie: 'Petit électroménager',
      prix_unitaire: 6500,
      stock_disponible: 40,
      photo_url: '/media/PROD31.webp'
    },
    {
      id: 'PROD32',
      designation: 'Radio Récepteur FM/SW/MW Rechargeable Solaire + Bluetooth',
      categorie: 'Petit électroménager',
      prix_unitaire: 7500,
      stock_disponible: 55,
      photo_url: '/media/PROD32.webp'
    },

    // Catégorie : Papeterie
    {
      id: 'PROD44',
      designation: 'Lot de 10 Cahiers 200 Pages Grands Carreaux + 10 Stylos Bleus',
      categorie: 'Papeterie',
      prix_unitaire: 4000,
      stock_disponible: 110,
      photo_url: '/media/PROD44.webp'
    },
    {
      id: 'PROD45',
      designation: 'Registre Comptable Commerçant Rigide 300 Pages',
      categorie: 'Papeterie',
      prix_unitaire: 3000,
      stock_disponible: 45,
      photo_url: '/media/PROD45.webp'
    }
  ];

  const insertArticle = db.prepare(`
    INSERT INTO articles (id, designation, categorie, prix_unitaire, stock_disponible, photo_url, photo_hash_md5, is_active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);

  for (const art of initialArticles) {
    insertArticle.run(
      art.id,
      art.designation,
      art.categorie,
      art.prix_unitaire,
      art.stock_disponible,
      art.photo_url,
      md5Hash(art.id + ':' + art.prix_unitaire),
      nowIso
    );
  }

  // Clients initiaux (dont CL890 cité en exemple dans la fiche technique)
  const insertClient = db.prepare(`
    INSERT INTO clients (id, telephone, nom_complet, ville, secteur_quartier, point_repere, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertClient.run(
    'CL890',
    '+22670112233',
    'Amadou Dicko',
    'Gorom-Gorom',
    'SEC3 (Secteur 3)',
    'Près du Château d\'Eau',
    nowIso
  );

  insertClient.run(
    'CL102',
    '+22676445566',
    'Fatoumata Maïga',
    'Dori',
    'SEC1 (Secteur 1 - Centre)',
    'Face Grande Mosquée',
    nowIso
  );

  insertClient.run(
    'CL205',
    '+22661889900',
    'Boureima Sawadogo',
    'Sebba',
    'SEC2 (Quartier Marché)',
    'À côté de la gare routière',
    nowIso
  );

  // Commande de démonstration initiale
  const demoOrderId = 'CMD-2026-001';
  db.prepare(`
    INSERT INTO commandes (id, client_id, total_fcfa, mode_transmission, mode_paiement, statut, adresse_livraison, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    demoOrderId,
    'CL102',
    37000,
    'DATA_HTTPS',
    'ORANGE_MONEY',
    'EN_COURS',
    'Dori - SEC1 (Secteur 1 - Centre) | Repère: Face Grande Mosquée',
    nowIso
  );

  db.prepare(`
    INSERT INTO lignes_commande (commande_id, article_id, quantite, prix_applique)
    VALUES (?, ?, ?, ?)
  `).run(demoOrderId, 'PROD01', 1, 32500);

  db.prepare(`
    INSERT INTO lignes_commande (commande_id, article_id, quantite, prix_applique)
    VALUES (?, ?, ?, ?)
  `).run(demoOrderId, 'PROD02', 1, 4500);
}

initSchema();
seedInitialData();

module.exports = {
  db,
  md5Hash
};
