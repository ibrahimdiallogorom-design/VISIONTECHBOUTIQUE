/**
 * SahelExpress - Gestionnaire de Base de Données Locale (IndexedDB)
 * Conforme au Chapitre 2 & 3.1 du Cahier des Charges :
 * - Stocke le catalogue complet localement pour navigation 100% hors-ligne
 * - Gère la synchronisation incrémentale par delta (hash + timestamp `updated_at`)
 * - Stocke le panier actif, le profil client et l'historique des commandes locales
 */

const IDB_NAME = 'SahelExpressLocalDB';
const IDB_VERSION = 1;

// Catalogue de secours embarqué dans le bundle pour garantir le 100% Offline dès la 1ère seconde
const FALLBACK_EMBEDDED_CATALOG = [
  { id: 'PROD01', designation: 'Kit Solaire Domestique 50W + Batterie Lithium + 3 Lampes LED', categorie: 'Solaire', prix_unitaire: 32500, stock_disponible: 25, photo_url: '/media/PROD01.webp', is_active: 1 },
  { id: 'PROD02', designation: 'Lampe Torche Solaire Rechargeable + Port USB Powerbank', categorie: 'Solaire', prix_unitaire: 4500, stock_disponible: 80, photo_url: '/media/PROD02.webp', is_active: 1 },
  { id: 'PROD03', designation: 'Panneau Solaire Monocristallin 150W 12V Haute Résilience', categorie: 'Solaire', prix_unitaire: 48000, stock_disponible: 14, photo_url: '/media/PROD03.webp', is_active: 1 },
  { id: 'PROD10', designation: 'Sac de Riz Brisure Parfumé 25 Kg', categorie: 'Consommables', prix_unitaire: 12500, stock_disponible: 120, photo_url: '/media/PROD10.webp', is_active: 1 },
  { id: 'PROD11', designation: 'Bidon Huile Alimentaire 5 Litres', categorie: 'Consommables', prix_unitaire: 5500, stock_disponible: 65, photo_url: '/media/PROD11.webp', is_active: 1 },
  { id: 'PROD12', designation: 'Carton de Savon de Ménage Local (24 Barres)', categorie: 'Consommables', prix_unitaire: 6000, stock_disponible: 50, photo_url: '/media/PROD12.webp', is_active: 1 },
  { id: 'PROD20', designation: 'Cadenas Acier Blindé Anti-Poussière 60mm', categorie: 'Quincaillerie', prix_unitaire: 2500, stock_disponible: 90, photo_url: '/media/PROD20.webp', is_active: 1 },
  { id: 'PROD21', designation: 'Brouette Renforcée Chantier Cuve Galvanisée 90L', categorie: 'Quincaillerie', prix_unitaire: 24000, stock_disponible: 18, photo_url: '/media/PROD21.webp', is_active: 1 },
  { id: 'PROD22', designation: 'Caisse à Outils Métallique Complète (32 Pièces)', categorie: 'Quincaillerie', prix_unitaire: 18500, stock_disponible: 22, photo_url: '/media/PROD22.webp', is_active: 1 },
  { id: 'PROD30', designation: 'Ventilateur Rechargeable 12V Solaire/Secteur Autonomie 10h', categorie: 'Petit électroménager', prix_unitaire: 21000, stock_disponible: 30, photo_url: '/media/PROD30.webp', is_active: 1 },
  { id: 'PROD31', designation: 'Bouilloire Électrique Inox Basse Consommation 1.8L', categorie: 'Petit électroménager', prix_unitaire: 6500, stock_disponible: 40, photo_url: '/media/PROD31.webp', is_active: 1 },
  { id: 'PROD32', designation: 'Radio Récepteur FM/SW/MW Rechargeable Solaire + Bluetooth', categorie: 'Petit électroménager', prix_unitaire: 7500, stock_disponible: 55, photo_url: '/media/PROD32.webp', is_active: 1 },
  { id: 'PROD44', designation: 'Lot de 10 Cahiers 200 Pages Grands Carreaux + 10 Stylos Bleus', categorie: 'Papeterie', prix_unitaire: 4000, stock_disponible: 110, photo_url: '/media/PROD44.webp', is_active: 1 },
  { id: 'PROD45', designation: 'Registre Comptable Commerçant Rigide 300 Pages', categorie: 'Papeterie', prix_unitaire: 3000, stock_disponible: 45, photo_url: '/media/PROD45.webp', is_active: 1 }
];

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
        }
        if (!db.objectStoreNames.contains('cart')) {
          db.createObjectStore('cart', { keyPath: 'article_id' });
        }
        if (!db.objectStoreNames.contains('orders_history')) {
          db.createObjectStore('orders_history', { keyPath: 'id' });
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
        const list = req.result || [];
        if (list.length === 0) {
          // Si IndexedDB est vide au tout premier lancement hors-ligne, charger le catalogue embarqué
          await this.applyDeltaSync(FALLBACK_EMBEDDED_CATALOG, []);
          resolve(FALLBACK_EMBEDDED_CATALOG);
        } else {
          resolve(list.filter((a) => Boolean(a.is_active)));
        }
      };
      req.onerror = () => resolve(FALLBACK_EMBEDDED_CATALOG);
    });
  }

  /**
   * Applique la mise à jour incrémentale (nouveautés, changements de prix/stocks et suppressions)
   */
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
}

window.SahelLocalStore = new LocalStore();
