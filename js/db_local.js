/**
 * SahelExpress - Gestionnaire de Base de Données Locale (IndexedDB)
 * Architecture souveraine Multi-Boutiques :
 * - Stocke le catalogue global Acheteur ET la base locale isolée de chaque Maître Marchand (`merchant_vault`)
 * - Permet au Maître Marchand d'inscrire, augmenter, diminuer, modifier ses prix et ses quantités 100% dans son téléphone
 * - Synchronise en temps réel la boutique locale du marchand avec le catalogue Acheteur sur le même téléphone et avec le serveur
 */

const IDB_NAME = 'SahelExpressLocalDB';
const IDB_VERSION = 4;

const DEFAULT_SUGGESTED_CATEGORIES = [
  'Thés de Santé',
  'Compléments Alimentaires',
  'Plantes & Bien-être',
  'Solaire',
  'Consommables',
  'Quincaillerie',
  'Petit électroménager',
  'Papeterie'
];

const FALLBACK_EMBEDDED_CATALOG = [
  { id: 'THE01', commercant_id: 'M-SAHEL', nom_boutique: 'SahelExpress Centrale (Gorom-Gorom)', designation: 'Thé Vert Détox & Digestion aux Plantes Naturelles (Boîte 20 Sachets)', description: 'Infusion naturelle purifiante favorisant la digestion, l\'élimination des toxines et le bien-être quotidien. Prendre 1 sachet matin et soir après le repas.', categorie: 'Thés de Santé', prix_unitaire: 3500, stock_disponible: 60, photo_url: '', is_active: 1 },
  { id: 'THE02', commercant_id: 'M-SAHEL', nom_boutique: 'SahelExpress Centrale (Gorom-Gorom)', designation: 'Infusion Moringa & Gingembre Bio Tonus et Immunité', description: 'Mélange riche en antioxydants, vitamines et minéraux naturels du Sahel pour renforcer l\'immunité et réduire la fatigue.', categorie: 'Thés de Santé', prix_unitaire: 4000, stock_disponible: 45, photo_url: '', is_active: 1 },
  { id: 'COMP01', commercant_id: 'M-SAHEL', nom_boutique: 'SahelExpress Centrale (Gorom-Gorom)', designation: 'Spiruline Pure du Sahel en Comprimés (Flacon de 120 gélules)', description: 'Complément alimentaire 100% naturel très riche en fer, protéines végétales et vitamines B12. Idéal contre l\'anémie, la fatigue et pour la récupération.', categorie: 'Compléments Alimentaires', prix_unitaire: 6500, stock_disponible: 40, photo_url: '', is_active: 1 },
  { id: 'COMP02', commercant_id: 'M-SAHEL', nom_boutique: 'SahelExpress Centrale (Gorom-Gorom)', designation: 'Complexe Multivitamines & Calcium Articulations (60 gélules)', description: 'Formule complète pour soutenir la vitalité, la solidité osseuse et le confort articulaire chez l\'adulte et les personnes âgées.', categorie: 'Compléments Alimentaires', prix_unitaire: 8500, stock_disponible: 35, photo_url: '', is_active: 1 },
  { id: 'PROD01', commercant_id: 'M-SAHEL', nom_boutique: 'SahelExpress Centrale (Gorom-Gorom)', designation: 'Kit Solaire Domestique 50W + Batterie Lithium + 3 Lampes LED', description: 'Kit solaire autonome complet avec panneau 50W, batterie LiFePO4 longue durée, 3 ampoules LED haute luminosité et sorties USB pour recharger les téléphones.', categorie: 'Solaire', prix_unitaire: 32500, stock_disponible: 25, photo_url: 'media/PROD01.webp', is_active: 1 },
  { id: 'PROD02', commercant_id: 'M-SAHEL', nom_boutique: 'SahelExpress Centrale (Gorom-Gorom)', designation: 'Lampe Torche Solaire Rechargeable + Port USB Powerbank', description: 'Lampe torche ultra-résistante avec panneau solaire intégré et batterie de secours USB pour téléphone. Autonomie jusqu\'à 12 heures.', categorie: 'Solaire', prix_unitaire: 4500, stock_disponible: 80, photo_url: 'media/PROD02.webp', is_active: 1 },
  { id: 'PROD03', commercant_id: 'M-SAHEL', nom_boutique: 'SahelExpress Centrale (Gorom-Gorom)', designation: 'Panneau Solaire Monocristallin 150W 12V Haute Résilience', description: 'Panneau solaire monocristallin haut rendement conçu pour résister aux fortes chaleurs et à la poussière du Sahel.', categorie: 'Solaire', prix_unitaire: 48000, stock_disponible: 14, photo_url: 'media/PROD03.webp', is_active: 1 },
  { id: 'PROD10', commercant_id: 'M-SAHEL', nom_boutique: 'SahelExpress Centrale (Gorom-Gorom)', designation: 'Sac de Riz Brisure Parfumé 25 Kg', description: 'Riz brisure parfumé de première qualité, propre et rapide à cuire, conditionné en sac résistant de 25 Kg.', categorie: 'Consommables', prix_unitaire: 12500, stock_disponible: 120, photo_url: 'media/PROD10.webp', is_active: 1 },
  { id: 'PROD11', commercant_id: 'M-SAHEL', nom_boutique: 'SahelExpress Centrale (Gorom-Gorom)', designation: 'Bidon Huile Alimentaire 5 Litres', description: 'Huile végétale raffinée enrichie en vitamine A, idéale pour la cuisine familiale quotidienne.', categorie: 'Consommables', prix_unitaire: 5500, stock_disponible: 65, photo_url: 'media/PROD11.webp', is_active: 1 },
  { id: 'PROD12', commercant_id: 'M-SAHEL', nom_boutique: 'SahelExpress Centrale (Gorom-Gorom)', designation: 'Carton de Savon de Ménage Local (24 Barres)', description: 'Savon multi-usage doux au beurre de karité pour la lessive et la toilette (carton économique de 24 barres).', categorie: 'Consommables', prix_unitaire: 6000, stock_disponible: 50, photo_url: 'media/PROD12.webp', is_active: 1 },
  { id: 'PROD20', commercant_id: 'M-DORI', nom_boutique: 'Faso Quincaillerie & Solaire (Dori)', designation: 'Cadenas Acier Blindé Anti-Poussière 60mm', description: 'Cadenas haute sécurité en acier trempé avec cache de protection contre le sable et livré avec 4 clés.', categorie: 'Quincaillerie', prix_unitaire: 2500, stock_disponible: 90, photo_url: 'media/PROD20.webp', is_active: 1 },
  { id: 'PROD21', commercant_id: 'M-DORI', nom_boutique: 'Faso Quincaillerie & Solaire (Dori)', designation: 'Brouette Renforcée Chantier Cuve Galvanisée 90L', description: 'Brouette professionnelle robuste avec roue increvable et cuve épaisse galvanisée anti-rouille de 90 litres.', categorie: 'Quincaillerie', prix_unitaire: 24000, stock_disponible: 18, photo_url: 'media/PROD21.webp', is_active: 1 },
  { id: 'PROD22', commercant_id: 'M-DORI', nom_boutique: 'Faso Quincaillerie & Solaire (Dori)', designation: 'Caisse à Outils Métallique Complète (32 Pièces)', description: 'Boîte à outils métallique 3 compartiments incluant tournevis, clés plates, pince universelle, marteau et mètre ruban.', categorie: 'Quincaillerie', prix_unitaire: 18500, stock_disponible: 22, photo_url: 'media/PROD22.webp', is_active: 1 },
  { id: 'PROD30', commercant_id: 'M-SAHEL', nom_boutique: 'SahelExpress Centrale (Gorom-Gorom)', designation: 'Ventilateur Rechargeable 12V Solaire/Secteur Autonomie 10h', description: 'Ventilateur oscillant silencieux fonctionnant sur secteur et sur batterie 12V avec entrée panneau solaire directe.', categorie: 'Petit électroménager', prix_unitaire: 21000, stock_disponible: 30, photo_url: 'media/PROD30.webp', is_active: 1 },
  { id: 'PROD31', commercant_id: 'M-DORI', nom_boutique: 'Faso Quincaillerie & Solaire (Dori)', designation: 'Bouilloire Électrique Inox Basse Consommation 1.8L', description: 'Bouilloire rapide en acier inoxydable alimentaire avec arrêt automatique à ébullition.', categorie: 'Petit électroménager', prix_unitaire: 6500, stock_disponible: 40, photo_url: 'media/PROD31.webp', is_active: 1 },
  { id: 'PROD32', commercant_id: 'M-DORI', nom_boutique: 'Faso Quincaillerie & Solaire (Dori)', designation: 'Radio Récepteur FM/SW/MW Rechargeable Solaire + Bluetooth', description: 'Poste radio multi-bandes haute sensibilité avec panneau solaire intégré, lampe LED, port clé USB et Bluetooth.', categorie: 'Petit électroménager', prix_unitaire: 7500, stock_disponible: 55, photo_url: 'media/PROD32.webp', is_active: 1 },
  { id: 'PROD44', commercant_id: 'M-SAHEL', nom_boutique: 'SahelExpress Centrale (Gorom-Gorom)', designation: 'Lot de 10 Cahiers 200 Pages Grands Carreaux + 10 Stylos Bleus', description: 'Pack scolaire et bureautique complet comprenant 10 cahiers 200 pages couverture plastifiée et 10 stylos bille.', categorie: 'Papeterie', prix_unitaire: 4000, stock_disponible: 110, photo_url: 'media/PROD44.webp', is_active: 1 },
  { id: 'PROD45', commercant_id: 'M-DORI', nom_boutique: 'Faso Quincaillerie & Solaire (Dori)', designation: 'Registre Comptable Commerçant Rigide 300 Pages', description: 'Grand registre relié pour le suivi quotidien des ventes, entrées/sorties de caisse et inventaire boutique.', categorie: 'Papeterie', prix_unitaire: 3000, stock_disponible: 45, photo_url: 'media/PROD45.webp', is_active: 1 }
];

/**
 * Retourne l'icône adaptée à n'importe quelle catégorie (pré-définie ou écrite librement par le commerçant)
 */
window.getCategoryIcon = function (catName) {
  if (!catName) return '📦';
  const lower = String(catName).toLowerCase();
  if (lower.includes('thé') || lower.includes('the') || lower.includes('infusion') || lower.includes('tisane')) return '🍵';
  if (lower.includes('complément') || lower.includes('complement') || lower.includes('vitamine') || lower.includes('santé') || lower.includes('sante') || lower.includes('gélule') || lower.includes('spiruline')) return '💊';
  if (lower.includes('plante') || lower.includes('nature') || lower.includes('bio') || lower.includes('bien-être') || lower.includes('herbe')) return '🌿';
  if (lower.includes('solaire') || lower.includes('énergie') || lower.includes('energie') || lower.includes('batterie')) return '☀️';
  if (lower.includes('consommable') || lower.includes('aliment') || lower.includes('vivre') || lower.includes('riz') || lower.includes('boisson')) return '🌾';
  if (lower.includes('quincaillerie') || lower.includes('outil') || lower.includes('chantier')) return '🛠️';
  if (lower.includes('électro') || lower.includes('electro') || lower.includes('appareil') || lower.includes('radio')) return '🔌';
  if (lower.includes('papeterie') || lower.includes('livre') || lower.includes('bureau')) return '📚';
  if (lower.includes('cosmétique') || lower.includes('beauté') || lower.includes('savon') || lower.includes('huile')) return '🧴';
  if (lower.includes('vêtement') || lower.includes('habit') || lower.includes('mode')) return '👕';
  return '🏷️';
};

/**
 * Récupère toutes les catégories disponibles (celles par défaut + celles créées librement par les commerçants + celles des articles)
 */
window.getAllAvailableCategories = function (articlesList = []) {
  let savedCustom = [];
  try {
    const raw = localStorage.getItem('sahel_custom_categories');
    if (raw) savedCustom = JSON.parse(raw);
  } catch {}

  const set = new Set([...DEFAULT_SUGGESTED_CATEGORIES, ...(Array.isArray(savedCustom) ? savedCustom : [])]);
  for (const a of articlesList) {
    if (a && a.categorie && String(a.categorie).trim()) {
      set.add(String(a.categorie).trim());
    }
  }
  return Array.from(set);
};

window.addCustomCategory = function (catName) {
  const clean = String(catName || '').trim();
  if (!clean) return;
  let savedCustom = [];
  try {
    const raw = localStorage.getItem('sahel_custom_categories');
    if (raw) savedCustom = JSON.parse(raw);
  } catch {}
  if (!Array.isArray(savedCustom)) savedCustom = [];
  if (!savedCustom.includes(clean)) {
    savedCustom.push(clean);
    localStorage.setItem('sahel_custom_categories', JSON.stringify(savedCustom));
  }
};

/**
 * Compresse automatiquement une photo prise ou choisie sur le téléphone en Base64 léger (< 35 Ko)
 * pour un stockage 100% hors-ligne dans IndexedDB et SQLite.
 */
window.compressProductPhotoFile = function (file, maxWidth = 480, quality = 0.78) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('Aucun fichier sélectionné'));
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width;
        let h = img.height;
        if (w > maxWidth) {
          h = Math.round((h * maxWidth) / w);
          w = maxWidth;
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve(dataUrl);
      };
      img.onerror = () => reject(new Error('Image invalide'));
      img.src = ev.target.result;
    };
    reader.onerror = () => reject(new Error('Erreur de lecture du fichier'));
    reader.readAsDataURL(file);
  });
};

/**
 * Vérifie si un produit possède une vraie photo affichable (Base64 data:image ou URL http/https)
 */
window.hasCustomProductPhoto = function (photoUrl) {
  if (!photoUrl || typeof photoUrl !== 'string') return false;
  const trimmed = photoUrl.trim();
  return trimmed.startsWith('data:image/') || trimmed.startsWith('http://') || trimmed.startsWith('https://');
};

class LocalStore {
  constructor() {
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('articles')) {
          const store = db.createObjectStore('articles', { keyPath: 'id' });
          store.createIndex('categorie', 'categorie', { unique: false });
          store.createIndex('commercant_id', 'commercant_id', { unique: false });
        }
        if (!db.objectStoreNames.contains('cart')) {
          db.createObjectStore('cart', { keyPath: 'article_id' });
        }
        if (!db.objectStoreNames.contains('orders_history')) {
          db.createObjectStore('orders_history', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('reviews_local')) {
          db.createObjectStore('reviews_local', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('merchant_stock_journal')) {
          db.createObjectStore('merchant_stock_journal', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async getMeta(key, defaultValue = null) {
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : defaultValue);
      req.onerror = () => resolve(defaultValue);
    });
  }

  async setMeta(key, value) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async getAllArticles() {
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction('articles', 'readonly');
      const req = tx.objectStore('articles').getAll();
      req.onsuccess = async () => {
        let list = req.result || [];
        if (list.length === 0) {
          await this.applyDeltaSync(FALLBACK_EMBEDDED_CATALOG, []);
          resolve(FALLBACK_EMBEDDED_CATALOG);
        } else {
          // S'assurer que les nouveaux articles de démonstration (Thés de Santé, Compléments Alimentaires) sont injectés s'ils manquent
          const existingIds = new Set(list.map((x) => x.id));
          const missingDefaults = FALLBACK_EMBEDDED_CATALOG.filter(
            (f) => ['THE01', 'THE02', 'COMP01', 'COMP02'].includes(f.id) && !existingIds.has(f.id)
          );
          if (missingDefaults.length > 0) {
            await this.applyDeltaSync(missingDefaults, []);
            list = [...missingDefaults, ...list];
          }

          const enriched = list
            .filter((a) => a.is_active === undefined || Boolean(a.is_active))
            .map((a) => {
              const fb = FALLBACK_EMBEDDED_CATALOG.find((f) => f.id === a.id);
              return {
                commercant_id: a.commercant_id || (fb ? fb.commercant_id : 'M-SAHEL'),
                nom_boutique: a.nom_boutique || (fb ? fb.nom_boutique : 'SahelExpress Centrale'),
                description: a.description !== undefined && a.description !== '' ? a.description : (fb ? fb.description : ''),
                ...a,
                description: a.description !== undefined && a.description !== '' ? a.description : (fb ? fb.description : '')
              };
            });
          resolve(enriched);
        }
      };
      req.onerror = () => resolve(FALLBACK_EMBEDDED_CATALOG);
    });
  }

  /**
   * Récupère uniquement les articles stockés dans le téléphone appartenant à un Maître Marchand donné
   */
  async getMerchantArticles(commercantId) {
    const all = await this.getAllArticles();
    return all.filter((a) => a.commercant_id === commercantId);
  }

  /**
   * Sauvegarde ou met à jour un article directement dans le téléphone du Maître Marchand (IndexedDB)
   */
  async upsertMerchantArticle(article, actionLabel = 'Modification locale') {
    const db = await this.open();
    const record = {
      ...article,
      is_active: article.is_active === undefined ? 1 : article.is_active,
      updated_at: new Date().toISOString()
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction(['articles', 'merchant_stock_journal'], 'readwrite');
      tx.objectStore('articles').put(record);
      tx.objectStore('merchant_stock_journal').add({
        commercant_id: record.commercant_id,
        article_id: record.id,
        designation: record.designation,
        prix_unitaire: record.prix_unitaire,
        stock_disponible: record.stock_disponible,
        action: actionLabel,
        timestamp: record.updated_at
      });
      tx.oncomplete = () => resolve(record);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Supprime un article de la boutique locale du Maître Marchand
   */
  async deleteMerchantArticle(articleId, commercantId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['articles', 'merchant_stock_journal'], 'readwrite');
      tx.objectStore('articles').delete(articleId);
      tx.objectStore('merchant_stock_journal').add({
        commercant_id: commercantId,
        article_id: articleId,
        designation: articleId,
        prix_unitaire: 0,
        stock_disponible: 0,
        action: 'Suppression article',
        timestamp: new Date().toISOString()
      });
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Récupère l'historique des mouvements de stock/prix effectués sur le téléphone du marchand
   */
  async getMerchantJournal(commercantId) {
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction('merchant_stock_journal', 'readonly');
      const req = tx.objectStore('merchant_stock_journal').getAll();
      req.onsuccess = () => {
        const list = (req.result || []).filter((j) => j.commercant_id === commercantId);
        list.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
        resolve(list.slice(0, 30));
      };
      req.onerror = () => resolve([]);
    });
  }

  async applyDeltaSync(updatedArticles = [], deletedIds = []) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('articles', 'readwrite');
      const store = tx.objectStore('articles');

      for (const art of updatedArticles) {
        store.put(art);
      }
      for (const id of deletedIds) {
        store.delete(id);
      }

      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async getCart() {
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction('cart', 'readonly');
      const req = tx.objectStore('cart').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async setCartItem(article, quantite) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('cart', 'readwrite');
      const store = tx.objectStore('cart');
      if (quantite <= 0) {
        store.delete(article.id);
      } else {
        store.put({
          article_id: article.id,
          commercant_id: article.commercant_id || 'M-SAHEL',
          nom_boutique: article.nom_boutique || 'SahelExpress Centrale',
          designation: article.designation,
          categorie: article.categorie,
          prix_unitaire: article.prix_unitaire,
          quantite
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async clearCart() {
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction('cart', 'readwrite');
      tx.objectStore('cart').clear();
      tx.oncomplete = () => resolve();
    });
  }

  async saveLocalOrder(orderRecord) {
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction('orders_history', 'readwrite');
      tx.objectStore('orders_history').put(orderRecord);
      tx.oncomplete = () => resolve();
    });
  }

  async getLocalOrders() {
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction('orders_history', 'readonly');
      const req = tx.objectStore('orders_history').getAll();
      req.onsuccess = () => {
        const list = req.result || [];
        list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
        resolve(list);
      };
      req.onerror = () => resolve([]);
    });
  }

  async saveLocalReview(review) {
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction('reviews_local', 'readwrite');
      tx.objectStore('reviews_local').put(review);
      tx.oncomplete = () => resolve();
    });
  }

  async getLocalReviews() {
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction('reviews_local', 'readonly');
      const req = tx.objectStore('reviews_local').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }
}

window.SahelLocalStore = new LocalStore();
