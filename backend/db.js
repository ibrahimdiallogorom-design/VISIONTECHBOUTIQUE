/**
 * SahelExpress - Module Base de Données Relationnelle Multi-Commerçants (SaaS Multi-Tenant)
 * - Isolation stricte des comptes commerçants (table `commercants` + `commercant_id` sur articles et commandes)
 * - Base de données Acheteurs & CRM WhatsApp (table `clients` + table `avis_clients`)
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

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA synchronous = NORMAL;');

function md5Hash(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function hashPassword(password, salt = 'sahel-salt-2026') {
  return crypto.pbkdf2Sync(String(password), salt, 1000, 32, 'sha256').toString('hex');
}

function addColumnIfNotExists(table, columnDef) {
  const colName = columnDef.split(' ')[0];
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === colName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  }
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS commercants (
      id VARCHAR(36) PRIMARY KEY,
      nom_boutique VARCHAR(120) NOT NULL,
      nom_gerant VARCHAR(100) NOT NULL,
      telephone VARCHAR(25) UNIQUE NOT NULL,
      whatsapp VARCHAR(25),
      ville VARCHAR(50) DEFAULT 'Gorom-Gorom',
      categorie_principale VARCHAR(60) DEFAULT ' Commerce Général',
      code_sms VARCHAR(15) UNIQUE NOT NULL,
      password_hash VARCHAR(128) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS clients (
      id VARCHAR(36) PRIMARY KEY,
      telephone VARCHAR(20) UNIQUE NOT NULL,
      whatsapp VARCHAR(25),
      nom_complet VARCHAR(100),
      ville VARCHAR(50) DEFAULT 'Gorom-Gorom',
      secteur_quartier VARCHAR(100),
      point_repere TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS articles (
      id VARCHAR(20) PRIMARY KEY,
      commercant_id VARCHAR(36) DEFAULT 'M-SAHEL',
      designation VARCHAR(150) NOT NULL,
      description TEXT DEFAULT '',
      categorie VARCHAR(80),
      prix_unitaire INTEGER NOT NULL,
      stock_disponible INTEGER DEFAULT 0,
      photo_url TEXT,
      photo_hash_md5 VARCHAR(32),
      is_active BOOLEAN DEFAULT 1,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS commandes (
      id VARCHAR(36) PRIMARY KEY,
      commercant_id VARCHAR(36) DEFAULT 'M-SAHEL',
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

    CREATE TABLE IF NOT EXISTS avis_clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      commercant_id VARCHAR(36) NOT NULL,
      article_id VARCHAR(20),
      client_id VARCHAR(36),
      client_nom VARCHAR(100),
      client_whatsapp VARCHAR(25),
      note INTEGER CHECK (note >= 1 AND note <= 5),
      commentaire TEXT,
      suggestion_produit TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration douce si la base existait déjà
  addColumnIfNotExists('clients', 'whatsapp VARCHAR(25)');
  addColumnIfNotExists('articles', "commercant_id VARCHAR(36) DEFAULT 'M-SAHEL'");
  addColumnIfNotExists('articles', "description TEXT DEFAULT ''");
  addColumnIfNotExists('commandes', "commercant_id VARCHAR(36) DEFAULT 'M-SAHEL'");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_articles_commercant ON articles(commercant_id);
    CREATE INDEX IF NOT EXISTS idx_commandes_commercant ON commandes(commercant_id);
    CREATE INDEX IF NOT EXISTS idx_avis_commercant ON avis_clients(commercant_id);
  `);
}

function seedInitialData() {
  const nowIso = new Date().toISOString();

  // 1. Création de 2 comptes commerçants distincts et totalement isolés
  const merchCount = db.prepare('SELECT COUNT(*) as c FROM commercants').get().c;
  if (merchCount === 0) {
    const insertMerch = db.prepare(`
      INSERT INTO commercants (id, nom_boutique, nom_gerant, telephone, whatsapp, ville, categorie_principale, code_sms, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Commerçant 1 : Centrale SahelExpress (PIN / Mot de passe: 1234)
    insertMerch.run(
      'M-SAHEL',
      'SahelExpress Centrale (Gorom-Gorom)',
      'Ibrahim Diallo',
      '+22670001122',
      '+22670001122',
      'Gorom-Gorom',
      'Thés de Santé, Compléments & Énergie',
      'SAHEL',
      hashPassword('1234'),
      nowIso
    );

    // Commerçant 2 : Quincaillerie & Électro Liptako Dori (PIN / Mot de passe: 5678)
    insertMerch.run(
      'M-DORI',
      'Faso Quincaillerie & Solaire (Dori)',
      'Ousmane Dicko',
      '+22676003344',
      '+22676003344',
      'Dori',
      'Quincaillerie & Équipement Pro',
      'FASO',
      hashPassword('5678'),
      nowIso
    );
  }

  // 2. Peuplement des articles s'ils n'existent pas
  const countRow = db.prepare('SELECT COUNT(*) as total FROM articles').get();
  if (countRow && countRow.total === 0) {
    const initialArticles = [
      // Boutique 1 : M-SAHEL (inclut Thés de Santé, Compléments Alimentaires, Solaire, Consommables)
      { id: 'THE01', commercant_id: 'M-SAHEL', designation: 'Thé Vert Détox & Digestion aux Plantes Naturelles (Boîte 20 Sachets)', description: 'Infusion naturelle purifiante favorisant la digestion, l\'élimination des toxines et le bien-être quotidien. Prendre 1 sachet matin et soir après le repas.', categorie: 'Thés de Santé', prix_unitaire: 3500, stock_disponible: 60, photo_url: '' },
      { id: 'THE02', commercant_id: 'M-SAHEL', designation: 'Infusion Moringa & Gingembre Bio Tonus et Immunité', description: 'Mélange riche en antioxydants, vitamines et minéraux naturels du Sahel pour renforcer l\'immunité et réduire la fatigue.', categorie: 'Thés de Santé', prix_unitaire: 4000, stock_disponible: 45, photo_url: '' },
      { id: 'COMP01', commercant_id: 'M-SAHEL', designation: 'Spiruline Pure du Sahel en Comprimés (Flacon de 120 gélules)', description: 'Complément alimentaire 100% naturel très riche en fer, protéines végétales et vitamines B12. Idéal contre l\'anémie, la fatigue et pour la récupération.', categorie: 'Compléments Alimentaires', prix_unitaire: 6500, stock_disponible: 40, photo_url: '' },
      { id: 'COMP02', commercant_id: 'M-SAHEL', designation: 'Complexe Multivitamines & Calcium Articulations (60 gélules)', description: 'Formule complète pour soutenir la vitalité, la solidité osseuse et le confort articulaire chez l\'adulte et les personnes âgées.', categorie: 'Compléments Alimentaires', prix_unitaire: 8500, stock_disponible: 35, photo_url: '' },
      { id: 'PROD01', commercant_id: 'M-SAHEL', designation: 'Kit Solaire Domestique 50W + Batterie Lithium + 3 Lampes LED', description: 'Kit solaire autonome complet avec panneau 50W, batterie LiFePO4 longue durée, 3 ampoules LED haute luminosité et sorties USB pour recharger les téléphones.', categorie: 'Solaire', prix_unitaire: 32500, stock_disponible: 25, photo_url: 'media/PROD01.webp' },
      { id: 'PROD02', commercant_id: 'M-SAHEL', designation: 'Lampe Torche Solaire Rechargeable + Port USB Powerbank', description: 'Lampe torche ultra-résistante avec panneau solaire intégré et batterie de secours USB pour téléphone. Autonomie jusqu\'à 12 heures.', categorie: 'Solaire', prix_unitaire: 4500, stock_disponible: 80, photo_url: 'media/PROD02.webp' },
      { id: 'PROD03', commercant_id: 'M-SAHEL', designation: 'Panneau Solaire Monocristallin 150W 12V Haute Résilience', description: 'Panneau solaire monocristallin haut rendement conçu pour résister aux fortes chaleurs et à la poussière du Sahel.', categorie: 'Solaire', prix_unitaire: 48000, stock_disponible: 14, photo_url: 'media/PROD03.webp' },
      { id: 'PROD10', commercant_id: 'M-SAHEL', designation: 'Sac de Riz Brisure Parfumé 25 Kg', description: 'Riz brisure parfumé de première qualité, propre et rapide à cuire, conditionné en sac résistant de 25 Kg.', categorie: 'Consommables', prix_unitaire: 12500, stock_disponible: 120, photo_url: 'media/PROD10.webp' },
      { id: 'PROD11', commercant_id: 'M-SAHEL', designation: 'Bidon Huile Alimentaire 5 Litres', description: 'Huile végétale raffinée enrichie en vitamine A, idéale pour la cuisine familiale quotidienne.', categorie: 'Consommables', prix_unitaire: 5500, stock_disponible: 65, photo_url: 'media/PROD11.webp' },
      { id: 'PROD12', commercant_id: 'M-SAHEL', designation: 'Carton de Savon de Ménage Local (24 Barres)', description: 'Savon multi-usage doux au beurre de karité pour la lessive et la toilette (carton économique de 24 barres).', categorie: 'Consommables', prix_unitaire: 6000, stock_disponible: 50, photo_url: 'media/PROD12.webp' },
      { id: 'PROD30', commercant_id: 'M-SAHEL', designation: 'Ventilateur Rechargeable 12V Solaire/Secteur Autonomie 10h', description: 'Ventilateur oscillant silencieux fonctionnant sur secteur et sur batterie 12V avec entrée panneau solaire directe.', categorie: 'Petit électroménager', prix_unitaire: 21000, stock_disponible: 30, photo_url: 'media/PROD30.webp' },
      { id: 'PROD44', commercant_id: 'M-SAHEL', designation: 'Lot de 10 Cahiers 200 Pages Grands Carreaux + 10 Stylos Bleus', description: 'Pack scolaire et bureautique complet comprenant 10 cahiers 200 pages couverture plastifiée et 10 stylos bille.', categorie: 'Papeterie', prix_unitaire: 4000, stock_disponible: 110, photo_url: 'media/PROD44.webp' },

      // Boutique 2 : M-DORI (Articles isolés pour le 2e commerçant)
      { id: 'PROD20', commercant_id: 'M-DORI', designation: 'Cadenas Acier Blindé Anti-Poussière 60mm', description: 'Cadenas haute sécurité en acier trempé avec cache de protection contre le sable et livré avec 4 clés.', categorie: 'Quincaillerie', prix_unitaire: 2500, stock_disponible: 90, photo_url: 'media/PROD20.webp' },
      { id: 'PROD21', commercant_id: 'M-DORI', designation: 'Brouette Renforcée Chantier Cuve Galvanisée 90L', description: 'Brouette professionnelle robuste avec roue increvable et cuve épaisse galvanisée anti-rouille de 90 litres.', categorie: 'Quincaillerie', prix_unitaire: 24000, stock_disponible: 18, photo_url: 'media/PROD21.webp' },
      { id: 'PROD22', commercant_id: 'M-DORI', designation: 'Caisse à Outils Métallique Complète (32 Pièces)', description: 'Boîte à outils métallique 3 compartiments incluant tournevis, clés plates, pince universelle, marteau et mètre ruban.', categorie: 'Quincaillerie', prix_unitaire: 18500, stock_disponible: 22, photo_url: 'media/PROD22.webp' },
      { id: 'PROD31', commercant_id: 'M-DORI', designation: 'Bouilloire Électrique Inox Basse Consommation 1.8L', description: 'Bouilloire rapide en acier inoxydable alimentaire avec arrêt automatique à ébullition.', categorie: 'Petit électroménager', prix_unitaire: 6500, stock_disponible: 40, photo_url: 'media/PROD31.webp' },
      { id: 'PROD32', commercant_id: 'M-DORI', designation: 'Radio Récepteur FM/SW/MW Rechargeable Solaire + Bluetooth', description: 'Poste radio multi-bandes haute sensibilité avec panneau solaire intégré, lampe LED, port clé USB et Bluetooth.', categorie: 'Petit électroménager', prix_unitaire: 7500, stock_disponible: 55, photo_url: 'media/PROD32.webp' },
      { id: 'PROD45', commercant_id: 'M-DORI', designation: 'Registre Comptable Commerçant Rigide 300 Pages', description: 'Grand registre relié pour le suivi quotidien des ventes, entrées/sorties de caisse et inventaire boutique.', categorie: 'Papeterie', prix_unitaire: 3000, stock_disponible: 45, photo_url: 'media/PROD45.webp' }
    ];

    const insertArt = db.prepare(`
      INSERT INTO articles (id, commercant_id, designation, description, categorie, prix_unitaire, stock_disponible, photo_url, photo_hash_md5, is_active, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `);
    for (const a of initialArticles) {
      insertArt.run(a.id, a.commercant_id, a.designation, a.description || '', a.categorie, a.prix_unitaire, a.stock_disponible, a.photo_url, md5Hash(a.id + ':' + a.prix_unitaire), nowIso);
    }
  } else {
    // S'assurer que les articles existants sont répartis sur les 2 commerçants de démo pour prouver l'isolation
    db.prepare(`UPDATE articles SET commercant_id = 'M-DORI' WHERE id IN ('PROD20', 'PROD21', 'PROD22', 'PROD31', 'PROD32', 'PROD45')`).run();
    db.prepare(`UPDATE articles SET commercant_id = 'M-SAHEL' WHERE commercant_id IS NULL OR commercant_id = ''`).run();
    // Ajouter les articles Thés de Santé et Compléments Alimentaires s'ils n'y sont pas encore
    const hasTea = db.prepare(`SELECT id FROM articles WHERE id = 'THE01'`).get();
    if (!hasTea) {
      const ins = db.prepare(`
        INSERT OR IGNORE INTO articles (id, commercant_id, designation, description, categorie, prix_unitaire, stock_disponible, photo_url, photo_hash_md5, is_active, updated_at)
        VALUES (?, 'M-SAHEL', ?, ?, ?, ?, ?, '', ?, 1, ?)
      `);
      ins.run('THE01', 'Thé Vert Détox & Digestion aux Plantes Naturelles (Boîte 20 Sachets)', 'Infusion naturelle purifiante favorisant la digestion, l\'élimination des toxines et le bien-être quotidien. Prendre 1 sachet matin et soir après le repas.', 'Thés de Santé', 3500, 60, md5Hash('THE01:3500'), nowIso);
      ins.run('THE02', 'Infusion Moringa & Gingembre Bio Tonus et Immunité', 'Mélange riche en antioxydants, vitamines et minéraux naturels du Sahel pour renforcer l\'immunité et réduire la fatigue.', 'Thés de Santé', 4000, 45, md5Hash('THE02:4000'), nowIso);
      ins.run('COMP01', 'Spiruline Pure du Sahel en Comprimés (Flacon de 120 gélules)', 'Complément alimentaire 100% naturel très riche en fer, protéines végétales et vitamines B12. Idéal contre l\'anémie, la fatigue et pour la récupération.', 'Compléments Alimentaires', 6500, 40, md5Hash('COMP01:6500'), nowIso);
      ins.run('COMP02', 'Complexe Multivitamines & Calcium Articulations (60 gélules)', 'Formule complète pour soutenir la vitalité, la solidité osseuse et le confort articulaire chez l\'adulte et les personnes âgées.', 'Compléments Alimentaires', 8500, 35, md5Hash('COMP02:8500'), nowIso);
    }
  }

  // S'assurer que les clients existants ont un numéro WhatsApp renseigné
  db.prepare(`UPDATE clients SET whatsapp = telephone WHERE whatsapp IS NULL OR whatsapp = ''`).run();

  // Avis clients initiaux de démonstration
  const avisCount = db.prepare('SELECT COUNT(*) as c FROM avis_clients').get().c;
  if (avisCount === 0) {
    const insertAvis = db.prepare(`
      INSERT INTO avis_clients (commercant_id, article_id, client_id, client_nom, client_whatsapp, note, commentaire, suggestion_produit, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertAvis.run(
      'M-SAHEL',
      'PROD01',
      'CL890',
      'Amadou Dicko',
      '+22670112233',
      5,
      'Le kit solaire 50W tient toute la nuit, très satisfait de la livraison au Secteur 3.',
      'Pourriez-vous proposer des batteries solaires 100Ah seules ?',
      nowIso
    );
    insertAvis.run(
      'M-DORI',
      'PROD21',
      'CL102',
      'Fatoumata Maïga',
      '+22676445566',
      5,
      'Brouette très solide pour nos travaux.',
      'Nous aimerions aussi commander des pelles et sacs de ciment.',
      nowIso
    );
  }
}

initSchema();
seedInitialData();

module.exports = {
  db,
  md5Hash,
  hashPassword
};
