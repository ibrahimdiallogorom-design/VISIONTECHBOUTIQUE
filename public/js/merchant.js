/**
 * SahelExpress - Module Maître Marchand (Stock Local dans le Téléphone + Comptes Isolés + CRM WhatsApp)
 * Fonctionnalités Souveraines du Maître Marchand :
 * 1. Toutes les données de sa boutique (articles, prix, quantités, journal des mouvements) sont stockées
 *    localement dans son téléphone (IndexedDB `SahelLocalStore`) et persistent 100% hors-ligne.
 * 2. Boutons rapides pour Ajuster les Quantités (-10, -1, +1, +10, saisie libre), Ajuster les Prix (-500, +500 FCFA, saisie libre),
 *    Modifier la Désignation/Catégorie, Inscrire un nouvel article ou Supprimer un article.
 * 3. Exportation / Importation de la sauvegarde JSON de sa boutique locale sur son téléphone.
 * 4. Isolation stricte entre les différents comptes marchands.
 */

const LOCAL_DEFAULT_MERCHANTS = [
  {
    id: 'M-SAHEL',
    nom_boutique: 'SahelExpress Centrale (Gorom-Gorom)',
    nom_gerant: 'Ibrahim Diallo',
    telephone: '+22670001122',
    whatsapp: '+22670001122',
    ville: 'Gorom-Gorom',
    categorie_principale: 'Solaire & Alimentation Générale',
    code_sms: 'SAHEL',
    pin: '1234'
  },
  {
    id: 'M-DORI',
    nom_boutique: 'Faso Quincaillerie & Solaire (Dori)',
    nom_gerant: 'Ousmane Dicko',
    telephone: '+22676003344',
    whatsapp: '+22676003344',
    ville: 'Dori',
    categorie_principale: 'Quincaillerie & Équipement Pro',
    code_sms: 'FASO',
    pin: '5678'
  }
];

function getSavedLocalMerchants() {
  try {
    const raw = localStorage.getItem('sahel_merchants_registry');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  localStorage.setItem('sahel_merchants_registry', JSON.stringify(LOCAL_DEFAULT_MERCHANTS));
  return LOCAL_DEFAULT_MERCHANTS;
}

function saveLocalMerchants(list) {
  localStorage.setItem('sahel_merchants_registry', JSON.stringify(list));
}

const merchantState = {
  currentMerchant: (() => {
    try {
      const s = sessionStorage.getItem('sahel_active_merchant');
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  })(),
  jwtToken: sessionStorage.getItem('sahel_active_merchant_jwt') || '',
  authMode: 'login',
  authError: '',
  activeTab: 'inventory', // Par défaut sur "Mes Stocks & Produits" pour que le Maître Marchand pilote sa boutique immédiatement
  statutFilter: 'ALL',
  channelFilter: 'ALL',
  inventorySearch: '',
  orders: [],
  articles: [],
  stockJournal: [],
  customers: [],
  avis: [],
  catalogHash: '',
  thermalModalOrder: null,
  thermalWidth: '80mm',
  lastSavedToast: '',
  promoProductText: 'Nouvel arrivage disponible dans notre boutique ! Commandez sur SahelExpress même hors-ligne.',
  gatewayTestSender: '+22670112233',
  gatewayTestSms: 'CMD#CL890#SEC3#PROD01:1;PROD10:2#ESP#FACE_CHATEAU_EAU',
  gatewayLastResponse: null
};

function formatFcfa(amount) {
  return Number(amount || 0).toLocaleString('fr-FR') + ' FCFA';
}

function formatDateTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return iso;
  }
}

function showSavedNotification(msg) {
  merchantState.lastSavedToast = msg;
  renderMerchantDashboard();
  setTimeout(() => {
    if (merchantState.lastSavedToast === msg) {
      merchantState.lastSavedToast = '';
      const toastEl = document.getElementById('local-save-toast');
      if (toastEl) toastEl.style.display = 'none';
    }
  }, 3000);
}

function getAuthHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (merchantState.jwtToken) {
    h['Authorization'] = `Bearer ${merchantState.jwtToken}`;
  }
  return h;
}

async function handleMerchantLogin(e) {
  e.preventDefault();
  merchantState.authError = '';
  const identifier = (document.getElementById('login-id').value || '').trim().replace(/\s+/g, '');
  const password = (document.getElementById('login-pin').value || '').trim();

  if (!identifier || !password) {
    merchantState.authError = 'Veuillez saisir votre numéro de téléphone (ou code boutique) et votre code PIN / mot de passe.';
    renderMerchantDashboard();
    return;
  }

  try {
    const res = await fetch('/api/merchants/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telephone: identifier, password })
    });
    if (res.ok) {
      const data = await res.json();
      setActiveMerchantSession(data.merchant, data.token);
      await fetchDashboardData();
      return;
    } else {
      const errData = await res.json().catch(() => ({}));
      if (res.status === 401) {
        merchantState.authError = errData.error || 'Identifiants commerçant incorrects.';
        renderMerchantDashboard();
        return;
      }
    }
  } catch {}

  const localMerchants = getSavedLocalMerchants();
  const found = localMerchants.find(
    (m) =>
      (m.telephone.replace(/\s+/g, '') === identifier ||
        m.id.toUpperCase() === identifier.toUpperCase() ||
        m.code_sms.toUpperCase() === identifier.toUpperCase()) &&
      m.pin === password
  );

  if (!found) {
    merchantState.authError = 'Compte introuvable ou code PIN / mot de passe incorrect.';
    renderMerchantDashboard();
    return;
  }

  setActiveMerchantSession(found, 'local-token-' + found.id);
  await fetchDashboardData();
}

async function handleMerchantRegister(e) {
  e.preventDefault();
  merchantState.authError = '';

  const nomBoutique = (document.getElementById('reg-boutique').value || '').trim();
  const nomGerant = (document.getElementById('reg-gerant').value || '').trim();
  const telephone = (document.getElementById('reg-tel').value || '').trim().replace(/\s+/g, '');
  const whatsapp = (document.getElementById('reg-whatsapp').value || telephone).trim().replace(/\s+/g, '');
  const ville = document.getElementById('reg-ville').value || 'Gorom-Gorom';
  const categoriePrincipale = document.getElementById('reg-cat').value || 'Commerce Général';
  const password = (document.getElementById('reg-pin').value || '').trim();

  if (!nomBoutique || !nomGerant || !telephone || password.length < 4) {
    merchantState.authError = 'Tous les champs sont requis et le code PIN/mot de passe doit contenir au moins 4 caractères.';
    renderMerchantDashboard();
    return;
  }

  try {
    const res = await fetch('/api/merchants/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nom_boutique: nomBoutique,
        nom_gerant: nomGerant,
        telephone,
        whatsapp,
        ville,
        categorie_principale: categoriePrincipale,
        password
      })
    });
    if (res.ok) {
      const data = await res.json();
      const list = getSavedLocalMerchants();
      list.push({ ...data.merchant, pin: password });
      saveLocalMerchants(list);

      setActiveMerchantSession(data.merchant, data.token);
      await fetchDashboardData();
      return;
    } else {
      const errData = await res.json().catch(() => ({}));
      if (res.status === 409 || res.status === 400) {
        merchantState.authError = errData.error || 'Impossible de créer ce compte.';
        renderMerchantDashboard();
        return;
      }
    }
  } catch {}

  const list = getSavedLocalMerchants();
  if (list.some((m) => m.telephone === telephone)) {
    merchantState.authError = 'Un compte commerçant existe déjà avec ce numéro de téléphone.';
    renderMerchantDashboard();
    return;
  }

  const newMerchant = {
    id: 'M-' + Date.now().toString(36).toUpperCase().slice(-5),
    nom_boutique: nomBoutique,
    nom_gerant: nomGerant,
    telephone,
    whatsapp,
    ville,
    categorie_principale: categoriePrincipale,
    code_sms: nomBoutique.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 5) + Math.floor(10 + Math.random() * 89),
    pin: password
  };

  list.push(newMerchant);
  saveLocalMerchants(list);
  setActiveMerchantSession(newMerchant, 'local-token-' + newMerchant.id);
  await fetchDashboardData();
}

function setActiveMerchantSession(merchant, token) {
  merchantState.currentMerchant = merchant;
  merchantState.jwtToken = token || '';
  sessionStorage.setItem('sahel_active_merchant', JSON.stringify(merchant));
  sessionStorage.setItem('sahel_active_merchant_jwt', merchantState.jwtToken);
}

function logoutMerchant() {
  merchantState.currentMerchant = null;
  merchantState.jwtToken = '';
  merchantState.orders = [];
  merchantState.articles = [];
  merchantState.customers = [];
  merchantState.avis = [];
  sessionStorage.removeItem('sahel_active_merchant');
  sessionStorage.removeItem('sahel_active_merchant_jwt');
  renderMerchantDashboard();
}

/**
 * Charge en priorité les données stockées dans le téléphone du Maître Marchand (IndexedDB)
 * puis synchronise avec le serveur si connecté.
 */
async function fetchDashboardData() {
  if (!merchantState.currentMerchant) {
    renderMerchantDashboard();
    return;
  }

  const merchId = merchantState.currentMerchant.id;
  const store = window.SahelLocalStore;

  // 1. Lecture immédiate depuis le téléphone (Stock Local IndexedDB)
  if (store) {
    merchantState.articles = await store.getMerchantArticles(merchId);
    merchantState.stockJournal = await store.getMerchantJournal(merchId);
  }

  // 2. Si le serveur est accessible, synchroniser les commandes, clients WhatsApp et avis
  try {
    const [ordersRes, crmRes] = await Promise.all([
      fetch(`/api/orders?commercant_id=${encodeURIComponent(merchId)}`, {
        headers: getAuthHeaders()
      }),
      fetch('/api/merchants/customers', {
        headers: getAuthHeaders()
      })
    ]);

    if (ordersRes.ok) {
      const oData = await ordersRes.json();
      merchantState.orders = oData.orders || [];
    }
    if (crmRes.ok) {
      const crmData = await crmRes.json();
      merchantState.customers = crmData.customers || [];
      merchantState.avis = crmData.avis || [];
    }
  } catch {
    // Hors-ligne : charger les infos locales
    const savedBuyerNom = localStorage.getItem('sahel_nom');
    const savedBuyerWa = localStorage.getItem('sahel_whatsapp');
    if (savedBuyerNom && savedBuyerWa) {
      merchantState.customers = [
        {
          id: localStorage.getItem('sahel_client_code') || 'CL890',
          nom_complet: savedBuyerNom,
          whatsapp: savedBuyerWa,
          ville: localStorage.getItem('sahel_ville') || 'Gorom-Gorom',
          secteur_quartier: localStorage.getItem('sahel_quartier') || 'SEC3',
          nb_commandes_boutique: 1,
          total_depense_fcfa: 32500
        }
      ];
    }
  }

  renderMerchantDashboard();
}

/**
 * Sauvegarde souveraine d'un article (désignation, catégorie, prix, quantité)
 * 1) Directement dans la mémoire du téléphone (IndexedDB)
 * 2) Puis synchronisation vers le serveur s'il est en ligne
 */
async function saveMerchantArticleEverywhere(articleObj, actionLabel) {
  const m = merchantState.currentMerchant;
  const fullArticle = {
    ...articleObj,
    commercant_id: m.id,
    nom_boutique: m.nom_boutique,
    prix_unitaire: Math.max(0, parseInt(articleObj.prix_unitaire || 0, 10)),
    stock_disponible: Math.max(0, parseInt(articleObj.stock_disponible || 0, 10))
  };

  // 1. Enregistrement immédiat dans le téléphone (IndexedDB)
  if (window.SahelLocalStore) {
    await window.SahelLocalStore.upsertMerchantArticle(fullArticle, actionLabel);
    merchantState.articles = await window.SahelLocalStore.getMerchantArticles(m.id);
    merchantState.stockJournal = await window.SahelLocalStore.getMerchantJournal(m.id);
  }

  // 2. Synchronisation vers le serveur (si en ligne)
  try {
    await fetch('/api/articles', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(fullArticle)
    });
  } catch {}

  showSavedNotification(
    `✅ Stocké dans le téléphone : ${fullArticle.id} (${formatFcfa(fullArticle.prix_unitaire)} • Qté: ${fullArticle.stock_disponible})`
  );
}

/**
 * Ajustement rapide en 1 clic (+1, -1, +10, -10 sur la quantité, ou +500 / -500 FCFA sur le prix)
 */
async function quickAdjustArticle(articleId, deltaPrix, deltaStock) {
  const art = merchantState.articles.find((a) => a.id === articleId);
  if (!art) return;

  // Lire les valeurs éventuellement modifiées dans les champs input à l'écran
  const inpDes = document.getElementById(`des-${articleId}`);
  const inpCat = document.getElementById(`cat-${articleId}`);
  const inpPrix = document.getElementById(`prix-${articleId}`);
  const inpStock = document.getElementById(`stock-${articleId}`);

  const basePrix = inpPrix ? parseInt(inpPrix.value, 10) : art.prix_unitaire;
  const baseStock = inpStock ? parseInt(inpStock.value, 10) : art.stock_disponible;

  const updated = {
    ...art,
    designation: inpDes ? inpDes.value.trim() : art.designation,
    categorie: inpCat ? inpCat.value : art.categorie,
    prix_unitaire: Math.max(0, basePrix + deltaPrix),
    stock_disponible: Math.max(0, baseStock + deltaStock)
  };

  const label =
    deltaStock !== 0
      ? `Ajustement quantité (${deltaStock > 0 ? '+' + deltaStock : deltaStock})`
      : deltaPrix !== 0
      ? `Ajustement prix (${deltaPrix > 0 ? '+' + deltaPrix : deltaPrix} FCFA)`
      : 'Modification directe';

  await saveMerchantArticleEverywhere(updated, label);
}

/**
 * Suppression d'un article de la boutique du Maître Marchand
 */
async function removeMerchantArticle(articleId) {
  const m = merchantState.currentMerchant;
  if (!confirm(`Voulez-vous vraiment retirer l'article ${articleId} de votre boutique ?`)) {
    return;
  }

  if (window.SahelLocalStore) {
    await window.SahelLocalStore.deleteMerchantArticle(articleId, m.id);
    merchantState.articles = await window.SahelLocalStore.getMerchantArticles(m.id);
    merchantState.stockJournal = await window.SahelLocalStore.getMerchantJournal(m.id);
  }

  try {
    await fetch(`/api/articles/${encodeURIComponent(articleId)}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ is_active: false })
    });
  } catch {}

  showSavedNotification(`🗑️ Article ${articleId} retiré du stock local de votre téléphone.`);
}

/**
 * Inscription d'un nouvel article par le Maître Marchand
 */
async function createNewArticle(e) {
  e.preventDefault();
  const m = merchantState.currentMerchant;
  const id = (document.getElementById('new-art-id').value || '').trim().toUpperCase();
  const designation = (document.getElementById('new-art-des').value || '').trim();
  const categorie = document.getElementById('new-art-cat').value;
  const prix = parseInt(document.getElementById('new-art-prix').value || '0', 10);
  const stock = parseInt(document.getElementById('new-art-stock').value || '0', 10);

  if (!designation || Number.isNaN(prix)) return;

  const newCode = id || 'PROD' + Math.floor(100 + Math.random() * 899);
  await saveMerchantArticleEverywhere(
    {
      id: newCode,
      commercant_id: m.id,
      nom_boutique: m.nom_boutique,
      designation,
      categorie,
      prix_unitaire: prix,
      stock_disponible: stock,
      photo_url: `media/${newCode}.webp`,
      is_active: 1
    },
    'Inscription nouvel article'
  );
}

/**
 * Exporter le stock local de la boutique en fichier JSON dans le téléphone
 */
function exportMerchantStockJson() {
  const m = merchantState.currentMerchant;
  const backup = {
    exported_at: new Date().toISOString(),
    merchant: m,
    articles: merchantState.articles,
    journal: merchantState.stockJournal
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Stock-${m.code_sms || m.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function changeOrderStatus(orderId, newStatut) {
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ statut: newStatut })
    });
    if (res.ok) {
      await fetchDashboardData();
    }
  } catch {}
}

async function triggerGatewayWebhook() {
  const sender = document.getElementById('gw-sender').value.trim();
  const message = document.getElementById('gw-message').value.trim();
  merchantState.gatewayTestSender = sender;
  merchantState.gatewayTestSms = message;

  const res = await fetch('/api/sms/incoming', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ from: sender, message })
  });

  const data = await res.json();
  merchantState.gatewayLastResponse = {
    httpStatus: res.status,
    ...data
  };
  await fetchDashboardData();
}

function renderMerchantAuthGate() {
  const savedMerchants = getSavedLocalMerchants();

  return `
    <div style="max-width: 900px; margin: 20px auto;">
      <div class="panel-card" style="border-color: var(--accent-amber); margin-bottom: 20px;">
        <h2>🔐 Accès Maître Marchand Protégé (Stock Local Téléphone & Multi-Comptes)</h2>
        <p style="font-size:0.92rem; color:var(--text-secondary); margin-bottom:14px;">
          Chaque Maître Marchand possède sa propre base de données stockée directement dans son téléphone (<strong>IndexedDB</strong>) et strictement isolée des autres boutiques. Connectez-vous pour gérer vos produits, ajuster vos prix et vos quantités :
        </p>

        <div class="category-pills" style="margin-bottom:16px;">
          <button type="button" class="cat-pill ${merchantState.authMode === 'login' ? 'active' : ''}" id="btn-switch-login">
            🔑 Se Connecter à ma Boutique
          </button>
          <button type="button" class="cat-pill ${merchantState.authMode === 'register' ? 'active' : ''}" id="btn-switch-register">
            ➕ Créer une Nouvelle Boutique Marchand
          </button>
        </div>

        ${
          merchantState.authError
            ? `<div style="padding:10px 14px; background:rgba(239,68,68,0.2); border:1px solid #ef4444; border-radius:8px; color:#fca5a5; margin-bottom:14px; font-weight:700;">
                 ⚠️ ${merchantState.authError}
               </div>`
            : ''
        }

        ${
          merchantState.authMode === 'login'
            ? `
              <form id="form-merchant-login">
                <div class="form-group">
                  <label>Numéro de Téléphone Commerçant (ou Code Boutique)</label>
                  <input type="text" id="login-id" class="form-control" placeholder="Ex: +22670001122 ou SAHEL" required />
                </div>
                <div class="form-group">
                  <label>Code PIN / Mot de passe secret</label>
                  <input type="password" id="login-pin" class="form-control" placeholder="••••" required />
                </div>
                <button type="submit" class="btn-primary" style="padding:13px; font-size:1rem;">
                  🔓 Ouvrir ma Boutique Maître Marchand
                </button>
              </form>

              <div style="margin-top:20px; padding-top:14px; border-top:1px dashed var(--border-color);">
                <small style="color:var(--text-muted); display:block; margin-bottom:8px; font-weight:700;">
                  🧪 COMPTES MAÎTRES MARCHANDS PRÉ-CONFIGURÉS (CLIQUEZ POUR TESTER) :
                </small>
                <div style="display:flex; gap:10px; flex-wrap:wrap;">
                  ${savedMerchants
                    .map(
                      (m) => `
                        <button type="button" class="btn-sim-offline" data-quick-login="${m.telephone}" data-quick-pin="${m.pin || '1234'}" style="padding:8px 12px; border-color:var(--accent-amber); color:var(--accent-amber);">
                          🏪 Ouvrir <strong>${m.nom_boutique}</strong> (${m.telephone} / PIN: ${m.pin || '1234'})
                        </button>
                      `
                    )
                    .join('')}
                </div>
              </div>
            `
            : `
              <form id="form-merchant-register">
                <div class="checkout-grid">
                  <div>
                    <div class="form-group">
                      <label>Nom de votre Boutique / Entreprise *</label>
                      <input type="text" id="reg-boutique" class="form-control" placeholder="Ex: Alimentation Générale Sebba" required />
                    </div>
                    <div class="form-group">
                      <label>Nom & Prénom du Maître Marchand *</label>
                      <input type="text" id="reg-gerant" class="form-control" placeholder="Ex: Moussa Diallo" required />
                    </div>
                    <div class="form-group">
                      <label>Ville / Localité *</label>
                      <select id="reg-ville" class="form-control">
                        <option value="Gorom-Gorom">Gorom-Gorom</option>
                        <option value="Dori">Dori</option>
                        <option value="Sebba">Sebba</option>
                        <option value="Markoye">Markoye</option>
                        <option value="Falagountou">Falagountou</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <div class="form-group">
                      <label>Numéro de Téléphone (Identifiant de connexion) *</label>
                      <input type="tel" id="reg-tel" class="form-control" placeholder="Ex: +22670998877" required />
                    </div>
                    <div class="form-group">
                      <label>Numéro WhatsApp Commercial *</label>
                      <input type="tel" id="reg-whatsapp" class="form-control" placeholder="Ex: +22670998877" required />
                    </div>
                    <div class="form-group">
                      <label>Catégorie Principale</label>
                      <select id="reg-cat" class="form-control">
                        <option value="Solaire & Énergie">Solaire & Énergie</option>
                        <option value="Consommables & Vivres">Consommables & Vivres</option>
                        <option value="Quincaillerie">Quincaillerie</option>
                        <option value="Petit électroménager">Petit électroménager</option>
                        <option value="Papeterie & Divers">Papeterie & Divers</option>
                      </select>
                    </div>
                  </div>
                </div>
                <div class="form-group">
                  <label>Choisissez votre Code PIN / Mot de passe secret (min. 4 caractères) *</label>
                  <input type="password" id="reg-pin" class="form-control" placeholder="Ex: 2026" required />
                </div>
                <button type="submit" class="btn-primary" style="padding:13px; font-size:1rem;">
                  🚀 Créer ma Boutique & mon Stock Local
                </button>
              </form>
            `
        }
      </div>
    </div>
  `;
}

/**
 * Vue Souveraine du Maître Marchand : Stock Local dans le Téléphone
 * Permet à tout moment d'inscrire, augmenter, diminuer, modifier la désignation, ajuster les prix et ajuster les quantités.
 */
function renderInventoryView() {
  const m = merchantState.currentMerchant;
  const totalRefs = merchantState.articles.length;
  const totalUnits = merchantState.articles.reduce((s, a) => s + (a.stock_disponible || 0), 0);
  const totalStockValue = merchantState.articles.reduce(
    (s, a) => s + (a.prix_unitaire || 0) * (a.stock_disponible || 0),
    0
  );

  const q = merchantState.inventorySearch.trim().toLowerCase();
  const filteredArticles = merchantState.articles.filter(
    (a) =>
      !q ||
      a.id.toLowerCase().includes(q) ||
      a.designation.toLowerCase().includes(q) ||
      (a.categorie && a.categorie.toLowerCase().includes(q))
  );

  const rowsHtml =
    filteredArticles.length === 0
      ? `<p style="color:var(--text-muted); padding:20px 0;">Aucun produit dans ce filtre. Utilisez le formulaire à droite pour inscrire un nouvel article dans votre boutique.</p>`
      : filteredArticles
          .map(
            (art) => `
          <div class="order-dispatch-card" style="border-left-color:var(--accent-amber); padding:14px; margin-bottom:12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
              <div style="display:flex; align-items:center; gap:8px; flex:1; min-width:240px;">
                <span class="product-code" style="font-size:0.86rem;">${art.id}</span>
                <input
                  type="text"
                  id="des-${art.id}"
                  class="form-control"
                  style="padding:7px 10px; font-weight:700;"
                  value="${art.designation.replace(/"/g, '&quot;')}"
                  title="Modifier le nom de l'article"
                />
              </div>
              <div style="display:flex; align-items:center; gap:6px;">
                <select id="cat-${art.id}" class="form-control" style="padding:7px 10px; width:auto;">
                  ${['Solaire', 'Consommables', 'Quincaillerie', 'Petit électroménager', 'Papeterie']
                    .map(
                      (c) =>
                        `<option value="${c}" ${
                          art.categorie === c ? 'selected' : ''
                        }>${c}</option>`
                    )
                    .join('')}
                </select>
                <button
                  type="button"
                  class="btn-sim-offline"
                  style="background:rgba(239,68,68,0.2); border-color:#ef4444; color:#fca5a5; padding:7px 10px;"
                  data-del-art="${art.id}"
                  title="Supprimer cet article"
                >
                  🗑️
                </button>
              </div>
            </div>

            <div style="display:grid; grid-template-columns: 1fr 1fr auto; gap:12px; align-items:end; margin-top:10px;">
              <!-- Contrôle souverain du PRIX UNITAIRE en FCFA -->
              <div style="background:var(--bg-main); padding:10px; border-radius:10px; border:1px solid var(--border-color);">
                <small style="display:block; color:var(--text-muted); font-size:0.75rem; font-weight:700; margin-bottom:6px;">
                  💰 AJUSTER LE PRIX UNITAIRE (FCFA)
                </small>
                <div style="display:flex; align-items:center; gap:6px;">
                  <button type="button" class="qty-btn" style="width:auto; padding:0 8px; font-size:0.8rem;" data-adj-id="${art.id}" data-adj-prix="-500" data-adj-stock="0">-500</button>
                  <input
                    type="number"
                    id="prix-${art.id}"
                    class="form-control"
                    style="text-align:center; font-weight:800; color:var(--accent-amber); padding:6px;"
                    value="${art.prix_unitaire}"
                  />
                  <button type="button" class="qty-btn" style="width:auto; padding:0 8px; font-size:0.8rem;" data-adj-id="${art.id}" data-adj-prix="500" data-adj-stock="0">+500</button>
                </div>
              </div>

              <!-- Contrôle souverain de la QUANTITÉ EN STOCK -->
              <div style="background:var(--bg-main); padding:10px; border-radius:10px; border:1px solid var(--border-color);">
                <small style="display:block; color:var(--text-muted); font-size:0.75rem; font-weight:700; margin-bottom:6px;">
                  📦 AJUSTER LA QUANTITÉ EN STOCK
                </small>
                <div style="display:flex; align-items:center; gap:5px;">
                  <button type="button" class="qty-btn" style="width:auto; padding:0 7px; font-size:0.78rem;" data-adj-id="${art.id}" data-adj-prix="0" data-adj-stock="-10">-10</button>
                  <button type="button" class="qty-btn" style="width:30px;" data-adj-id="${art.id}" data-adj-prix="0" data-adj-stock="-1">−</button>
                  <input
                    type="number"
                    id="stock-${art.id}"
                    class="form-control"
                    style="text-align:center; font-weight:800; color:#34d399; padding:6px;"
                    value="${art.stock_disponible}"
                  />
                  <button type="button" class="qty-btn" style="width:30px;" data-adj-id="${art.id}" data-adj-prix="0" data-adj-stock="1">+</button>
                  <button type="button" class="qty-btn" style="width:auto; padding:0 7px; font-size:0.78rem;" data-adj-id="${art.id}" data-adj-prix="0" data-adj-stock="10">+10</button>
                </div>
              </div>

              <!-- Bouton d'enregistrement direct -->
              <div>
                <button
                  type="button"
                  class="btn-primary"
                  style="padding:12px 16px; white-space:nowrap;"
                  data-save-art="${art.id}"
                >
                  💾 Enregistrer
                </button>
              </div>
            </div>
          </div>
        `
          )
          .join('');

  const journalHtml =
    merchantState.stockJournal.length === 0
      ? `<p style="color:var(--text-muted); font-size:0.84rem;">Aucun ajustement récent enregistré sur ce téléphone.</p>`
      : merchantState.stockJournal
          .slice(0, 8)
          .map(
            (j) => `
          <div style="display:flex; justify-content:space-between; font-size:0.8rem; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.06);">
            <span><strong>${j.article_id}</strong> — ${j.action}</span>
            <span style="color:var(--accent-amber);">${formatFcfa(j.prix_unitaire)} (Qté: ${j.stock_disponible})</span>
          </div>
        `
          )
          .join('');

  return `
    ${
      merchantState.lastSavedToast
        ? `<div id="local-save-toast" style="padding:12px 16px; background:#064e3b; border:1px solid #10b981; color:#a7f3d0; border-radius:10px; margin-bottom:16px; font-weight:700;">
             ${merchantState.lastSavedToast}
           </div>`
        : ''
    }

    <div class="kpi-grid">
      <div class="kpi-card" style="border-color:#10b981;">
        <small>📱 Stockage Téléphone (IndexedDB)</small>
        <div class="kpi-value" style="font-size:1.15rem; color:#34d399;">100% Actif & Autonome</div>
      </div>
      <div class="kpi-card">
        <small>Références dans ma Boutique</small>
        <div class="kpi-value">${totalRefs} produits</div>
      </div>
      <div class="kpi-card">
        <small>Quantité Totale en Stock</small>
        <div class="kpi-value" style="color:var(--accent-amber);">${totalUnits} unités</div>
      </div>
      <div class="kpi-card">
        <small>Valeur Totale de mon Stock</small>
        <div class="kpi-value" style="color:#34d399;">${formatFcfa(totalStockValue)}</div>
      </div>
    </div>

    <div class="checkout-grid">
      <div class="panel-card">
        <h2>
          <span>👑 Pilotage de ma Boutique : ${m.nom_boutique}</span>
          <button type="button" class="btn-sim-offline" id="btn-export-json" style="border-color:var(--accent-amber); color:var(--accent-amber);">
            📥 Sauvegarder mon Stock (.JSON)
          </button>
        </h2>
        <p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:12px;">
          Vous êtes le <strong>Maître Marchand</strong> de votre boutique : toutes vos modifications de noms, de prix et de quantités sont enregistrées instantanément dans la mémoire de votre téléphone et mises à jour dans le catalogue des acheteurs.
        </p>

        <div class="search-box" style="margin-bottom:14px;">
          <input
            type="search"
            id="merchant-inv-search"
            class="search-input"
            placeholder="🔍 Filtrer mes produits (nom, code PROD, catégorie...)"
            value="${merchantState.inventorySearch.replace(/"/g, '&quot;')}"
          />
        </div>

        ${rowsHtml}
      </div>

      <div>
        <div class="panel-card" style="margin-bottom:18px; border-color:var(--accent-amber);">
          <h2>➕ Inscrire un Nouvel Article dans ma Boutique</h2>
          <form id="form-new-article">
            <div class="form-group">
              <label>Code Article Court (pour commande SMS, ex: PROD60)</label>
              <input type="text" id="new-art-id" class="form-control" placeholder="Ex: PROD60 (ou laisser vide)" />
            </div>
            <div class="form-group">
              <label>Désignation complète du produit *</label>
              <input type="text" id="new-art-des" class="form-control" placeholder="Ex: Batterie Solaire Gel 100Ah 12V" required />
            </div>
            <div class="form-group">
              <label>Catégorie *</label>
              <select id="new-art-cat" class="form-control">
                <option value="Solaire">Solaire</option>
                <option value="Consommables">Consommables</option>
                <option value="Quincaillerie">Quincaillerie</option>
                <option value="Petit électroménager">Petit électroménager</option>
                <option value="Papeterie">Papeterie</option>
              </select>
            </div>
            <div class="form-group">
              <label>Prix Unitaire (en Francs CFA) *</label>
              <input type="number" id="new-art-prix" class="form-control" placeholder="Ex: 65000" required />
            </div>
            <div class="form-group">
              <label>Quantité Initiale en Stock *</label>
              <input type="number" id="new-art-stock" class="form-control" value="20" required />
            </div>
            <button type="submit" class="btn-primary" style="padding:13px;">
              🚀 Inscrire dans le Stock de mon Téléphone
            </button>
          </form>
        </div>

        <div class="panel-card">
          <h2>📜 Journal Local de mes Ajustements (Téléphone)</h2>
          ${journalHtml}
        </div>
      </div>
    </div>
  `;
}

function renderOrdersQueueView() {
  const m = merchantState.currentMerchant;
  const totalOrders = merchantState.orders.length;
  const smsOrdersCount = merchantState.orders.filter((o) => o.mode_transmission === 'SMS').length;
  const pendingCount = merchantState.orders.filter((o) => o.statut === 'RECUE' || o.statut === 'EN_COURS').length;
  const revenueTotal = merchantState.orders
    .filter((o) => o.statut !== 'ANNULEE')
    .reduce((s, o) => s + (o.total_fcfa || 0), 0);

  const filteredOrders = merchantState.orders.filter((o) => {
    const matchStatut =
      merchantState.statutFilter === 'ALL' || o.statut === merchantState.statutFilter;
    const matchChannel =
      merchantState.channelFilter === 'ALL' || o.mode_transmission === merchantState.channelFilter;
    return matchStatut && matchChannel;
  });

  const cardsHtml =
    filteredOrders.length === 0
      ? `<div class="panel-card" style="text-align:center; padding:32px; color:var(--text-muted);">
           Aucune commande enregistrée pour votre boutique (<strong>${m.nom_boutique}</strong>) dans ce filtre.
         </div>`
      : filteredOrders
          .map((o) => {
            const linesHtml = (o.lignes || [])
              .map(
                (l) => `
                  <div style="display:flex; justify-content:space-between; font-size:0.88rem; padding:3px 0;">
                    <span>• <strong>${l.quantite}x</strong> ${l.designation || l.article_id} <small style="color:var(--text-muted);">(${l.article_id})</small></span>
                    <span>${formatFcfa(l.prix_applique * l.quantite)}</span>
                  </div>
                `
              )
              .join('');

            const cleanTel = (o.client_telephone || '+22670112233').replace(/\s+/g, '');
            const cleanWa = (o.client_whatsapp || cleanTel).replace(/[^0-9]/g, '');

            return `
              <div class="order-dispatch-card channel-${o.mode_transmission}">
                <div class="order-dispatch-header">
                  <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                    <strong style="font-size:1.08rem; color:#fff;">#${o.id}</strong>
                    <span class="badge-channel ${o.mode_transmission}">
                      ${o.mode_transmission === 'SMS' ? '📩 REÇU PAR SMS GSM' : '🌐 DATA HTTPS / WI-FI'}
                    </span>
                    <span class="badge-statut ${o.statut}">
                      ${o.statut === 'RECUE' ? '⏳ En attente de préparation (RECUE)' : o.statut}
                    </span>
                    <small style="color:var(--text-muted);">🕒 ${formatDateTime(o.created_at)}</small>
                  </div>
                  <div style="font-size:1.22rem; font-weight:900; color:var(--accent-amber);">
                    ${formatFcfa(o.total_fcfa)}
                  </div>
                </div>

                <div style="display:grid; grid-template-columns: 1.2fr 1fr; gap:14px;">
                  <div>
                    <div style="font-size:0.9rem; margin-bottom:6px;">
                      👤 <strong>${o.client_nom || o.client_id}</strong>
                      <span class="product-code">${o.client_id}</span>
                      • 📞 <strong>${cleanTel}</strong>
                    </div>
                    <div style="font-size:0.88rem; color:var(--text-secondary);">
                      📍 <strong>Livraison :</strong> ${o.adresse_livraison || 'Gorom-Gorom'}
                    </div>
                    <div style="font-size:0.84rem; color:var(--text-muted); margin-top:4px;">
                      💳 <strong>Paiement :</strong> ${o.mode_paiement}
                    </div>
                  </div>

                  <div style="background:var(--bg-main); padding:10px 12px; border-radius:8px; border:1px solid var(--border-color);">
                    <div style="font-size:0.76rem; color:var(--text-muted); font-weight:700; margin-bottom:4px;">
                      ARTICLES DE VOTRE BOUTIQUE :
                    </div>
                    ${linesHtml}
                  </div>
                </div>

                <div class="dispatch-actions-bar">
                  <div style="display:flex; gap:8px; flex-wrap:wrap;">
                    <a href="tel:${cleanTel}" class="btn-call-client">
                      📞 Appeler (${cleanTel})
                    </a>
                    <a
                      href="https://wa.me/${cleanWa}?text=${encodeURIComponent(
                        `Bonjour ${o.client_nom || ''}, ici la boutique ${m.nom_boutique}. Votre commande #${o.id} (${formatFcfa(o.total_fcfa)}) est bien reçue !`
                      )}"
                      target="_blank"
                      rel="noopener"
                      class="btn-call-client"
                      style="background:#25D366; color:#052e16;"
                    >
                      💬 WhatsApp Client
                    </a>
                    <button type="button" class="btn-print-slip" data-slip-order="${o.id}">
                      🧾 Ticket Thermique (58mm/80mm)
                    </button>
                  </div>

                  <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                    <small style="color:var(--text-muted); font-weight:700;">Statut :</small>
                    <button type="button" class="cat-pill ${o.statut === 'RECUE' ? 'active' : ''}" data-status-order="${o.id}" data-status-val="RECUE">RECUE</button>
                    <button type="button" class="cat-pill ${o.statut === 'EN_COURS' ? 'active' : ''}" data-status-order="${o.id}" data-status-val="EN_COURS">EN_COURS</button>
                    <button type="button" class="cat-pill ${o.statut === 'LIVREE' ? 'active' : ''}" data-status-order="${o.id}" data-status-val="LIVREE">LIVREE</button>
                    <button type="button" class="cat-pill ${o.statut === 'ANNULEE' ? 'active' : ''}" data-status-order="${o.id}" data-status-val="ANNULEE">ANNULEE</button>
                  </div>
                </div>
              </div>
            `;
          })
          .join('');

  return `
    <div class="kpi-grid">
      <div class="kpi-card">
        <small>Mes Commandes (${m.nom_boutique})</small>
        <div class="kpi-value">${totalOrders}</div>
      </div>
      <div class="kpi-card">
        <small>Commandes par SMS</small>
        <div class="kpi-value" style="color:#fb923c;">${smsOrdersCount}</div>
      </div>
      <div class="kpi-card">
        <small>À Préparer / En Cours</small>
        <div class="kpi-value" style="color:#fbbf24;">${pendingCount}</div>
      </div>
      <div class="kpi-card">
        <small>Mon Chiffre d'Affaires</small>
        <div class="kpi-value" style="color:#34d399;">${formatFcfa(revenueTotal)}</div>
      </div>
    </div>

    <div class="orders-queue-list">${cardsHtml}</div>
  `;
}

function renderCrmWhatsappView() {
  const m = merchantState.currentMerchant;

  const customersHtml =
    merchantState.customers.length === 0
      ? `<p style="color:var(--text-muted);">Aucun client enregistré pour le moment.</p>`
      : merchantState.customers
          .map((c) => {
            const cleanWa = (c.whatsapp || c.telephone || '').replace(/[^0-9]/g, '');
            const msg = `Bonjour ${c.nom_complet}, ici la boutique *${m.nom_boutique}* (${m.ville}) sur SahelExpress ! ${merchantState.promoProductText}`;
            const waUrl = `https://wa.me/${cleanWa}?text=${encodeURIComponent(msg)}`;

            return `
              <div class="cart-item-row" style="flex-wrap:wrap;">
                <div>
                  <h4>👤 ${c.nom_complet} <span class="product-code">${c.id}</span></h4>
                  <small>📱 WhatsApp : <strong>${c.whatsapp || c.telephone}</strong> • 📍 ${c.ville} (${c.secteur_quartier || ''})</small>
                  <div style="font-size:0.78rem; color:var(--accent-amber); margin-top:2px;">
                    Commandes chez vous : <strong>${c.nb_commandes_boutique || 0}</strong> (${formatFcfa(c.total_depense_fcfa || 0)})
                  </div>
                </div>
                <div>
                  <a
                    href="${waUrl}"
                    target="_blank"
                    rel="noopener"
                    class="btn-call-client"
                    style="background:#25D366; color:#052e16;"
                  >
                    💬 Proposer un Produit sur WhatsApp
                  </a>
                </div>
              </div>
            `;
          })
          .join('');

  const avisHtml =
    merchantState.avis.length === 0
      ? `<p style="color:var(--text-muted);">Aucun avis ou suggestion reçu pour votre boutique pour le moment.</p>`
      : merchantState.avis
          .map((av) => {
            const cleanWa = (av.client_whatsapp || '').replace(/[^0-9]/g, '');
            const replyMsg = `Bonjour ${av.client_nom}, merci pour votre avis sur *${m.nom_boutique}* ! ${
              av.suggestion_produit
                ? `Concernant votre demande pour "${av.suggestion_produit}", nous l'avons bien notée et vous tiendrons informé.`
                : ''
            }`;
            return `
              <div class="cart-item-row" style="flex-direction:column; align-items:flex-start; gap:6px;">
                <div style="display:flex; justify-content:space-between; width:100%;">
                  <strong>👤 ${av.client_nom} <small style="color:#34d399;">(${av.client_whatsapp || ''})</small></strong>
                  <span style="color:var(--accent-amber);">${'⭐'.repeat(av.note || 5)}</span>
                </div>
                ${av.commentaire ? `<p style="font-size:0.9rem;">« ${av.commentaire} »</p>` : ''}
                ${
                  av.suggestion_produit
                    ? `<div style="font-size:0.84rem; color:#fde68a; background:rgba(245,158,11,0.15); padding:6px 10px; border-radius:6px; width:100%;">
                         💡 <strong>Produit demandé par ce client :</strong> ${av.suggestion_produit}
                       </div>`
                    : ''
                }
                ${
                  cleanWa
                    ? `<a href="https://wa.me/${cleanWa}?text=${encodeURIComponent(replyMsg)}" target="_blank" rel="noopener" style="font-size:0.8rem; color:#34d399; font-weight:700; text-decoration:none;">
                         ↪️ Répondre et proposer ce produit sur WhatsApp
                       </a>`
                    : ''
                }
              </div>
            `;
          })
          .join('');

  return `
    <div class="checkout-grid">
      <div class="panel-card">
        <h2>📱 Base Clients WhatsApp & Proposition de Produits</h2>
        <div class="form-group">
          <label>Message d'offre / Nouveau produit à proposer aux clients :</label>
          <textarea id="inp-promo-msg" class="form-control" rows="2">${merchantState.promoProductText}</textarea>
        </div>
        ${customersHtml}
      </div>

      <div class="panel-card">
        <h2>⭐ Avis Reçus & Produits Demandés (${m.nom_boutique})</h2>
        ${avisHtml}
      </div>
    </div>
  `;
}

function renderGatewaySimulatorView() {
  const resp = merchantState.gatewayLastResponse;
  return `
    <div class="checkout-grid">
      <div class="panel-card">
        <h2>📡 Console Passerelle SMS Locale</h2>
        <div class="form-group">
          <label>Numéro GSM Expéditeur (Client)</label>
          <input type="text" id="gw-sender" class="form-control" value="${merchantState.gatewayTestSender}" />
        </div>
        <div class="form-group">
          <label>Chaîne SMS Compactée reçue</label>
          <textarea id="gw-message" class="form-control" rows="3" style="font-family:monospace;">${merchantState.gatewayTestSms}</textarea>
        </div>
        <button type="button" class="btn-primary" id="btn-fire-sms">
          📩 Injecter le SMS dans la Passerelle & Décoder
        </button>
      </div>

      <div class="panel-card">
        <h2>🔍 Résultat du Décodage SMS</h2>
        ${
          !resp
            ? `<p style="color:var(--text-muted);">Cliquez sur « Injecter le SMS » pour observer le routage vers le compte commerçant correspondant.</p>`
            : `<pre style="background:#090d16; padding:12px; border-radius:8px; overflow-x:auto; font-size:0.78rem; color:#cbd5e1;">${JSON.stringify(
                resp,
                null,
                2
              )}</pre>`
        }
      </div>
    </div>
  `;
}

function renderThermalSlipModal() {
  const modalRoot = document.getElementById('merchant-modal-root');
  if (!modalRoot) return;

  const order = merchantState.thermalModalOrder;
  if (!order) {
    modalRoot.innerHTML = '';
    return;
  }

  const m = merchantState.currentMerchant;
  const linesRows = (order.lignes || [])
    .map(
      (l) => `
        <tr>
          <td>${l.quantite}x ${l.article_id}<br/><small>${l.designation || ''}</small></td>
          <td class="right">${Number(l.prix_applique * l.quantite).toLocaleString('fr-FR')}</td>
        </tr>
      `
    )
    .join('');

  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="thermal-backdrop">
      <div class="modal-box" style="max-width:460px;" onclick="event.stopPropagation()">
        <div class="modal-header no-print">
          <h3>🧾 Bon de Livraison Thermique</h3>
          <button type="button" class="btn-close" id="btn-close-thermal">✕</button>
        </div>

        <div class="no-print" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; gap:8px;">
          <div style="display:flex; gap:6px;">
            <button type="button" class="cat-pill ${merchantState.thermalWidth === '58mm' ? 'active' : ''}" id="btn-width-58">58mm</button>
            <button type="button" class="cat-pill ${merchantState.thermalWidth === '80mm' ? 'active' : ''}" id="btn-width-80">80mm</button>
          </div>
          <button type="button" class="btn-primary" style="width:auto; padding:8px 14px;" id="btn-trigger-print">
            🖨️ Imprimer Ticket
          </button>
        </div>

        <div id="thermal-print-area" class="thermal-slip-wrapper width-${merchantState.thermalWidth}">
          <div class="thermal-center">
            <strong style="font-size:1.2em;">${m ? m.nom_boutique.toUpperCase() : 'SAHEL EXPRESS'}</strong><br/>
            <span>Gérant : ${m ? m.nom_gerant : ''} • Tél : ${m ? m.telephone : ''}</span>
          </div>
          <div class="thermal-divider"></div>
          <div>
            <strong>BON DE LIVRAISON : #${order.id}</strong><br/>
            <span>Date : ${formatDateTime(order.created_at)}</span>
          </div>
          <div class="thermal-divider"></div>
          <div>
            <strong>CLIENT : ${order.client_nom || order.client_id}</strong><br/>
            <span>WhatsApp/Tél : ${order.client_whatsapp || order.client_telephone || 'N/A'}</span><br/>
            <strong>${order.adresse_livraison || 'Gorom-Gorom'}</strong>
          </div>
          <div class="thermal-divider"></div>
          <table class="thermal-table">
            <thead>
              <tr>
                <th>ARTICLE (QTÉ)</th>
                <th class="right">TOTAL FCFA</th>
              </tr>
            </thead>
            <tbody>${linesRows}</tbody>
          </table>
          <div class="thermal-divider"></div>
          <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:1.15em;">
            <span>NET À PAYER :</span>
            <span>${formatFcfa(order.total_fcfa)}</span>
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('btn-close-thermal').onclick = () => {
    merchantState.thermalModalOrder = null;
    renderThermalSlipModal();
  };
  document.getElementById('thermal-backdrop').onclick = () => {
    merchantState.thermalModalOrder = null;
    renderThermalSlipModal();
  };
  document.getElementById('btn-width-58').onclick = () => {
    merchantState.thermalWidth = '58mm';
    renderThermalSlipModal();
  };
  document.getElementById('btn-width-80').onclick = () => {
    merchantState.thermalWidth = '80mm';
    renderThermalSlipModal();
  };
  document.getElementById('btn-trigger-print').onclick = () => window.print();
}

function renderMerchantDashboard() {
  const headerEl = document.getElementById('merchant-authenticated-header');
  const bannerTitle = document.getElementById('merchant-banner-title');
  const btnRefresh = document.getElementById('btn-refresh-dashboard');
  const btnLogout = document.getElementById('btn-logout-merchant');
  const root = document.getElementById('merchant-view-root');
  if (!root) return;

  if (!merchantState.currentMerchant) {
    if (headerEl) headerEl.style.display = 'none';
    if (btnRefresh) btnRefresh.style.display = 'none';
    if (btnLogout) btnLogout.style.display = 'none';
    if (bannerTitle) {
      bannerTitle.textContent = '🔒 Espace Maître Marchand Verrouillé — Connexion Obligatoire';
    }
    root.innerHTML = renderMerchantAuthGate();
    bindAuthEvents();
    return;
  }

  const m = merchantState.currentMerchant;
  if (headerEl) headerEl.style.display = 'flex';
  if (btnRefresh) btnRefresh.style.display = 'inline-block';
  if (btnLogout) btnLogout.style.display = 'inline-block';
  if (bannerTitle) {
    bannerTitle.textContent = `👑 Maître Marchand : ${m.nom_boutique} (Stock Local Téléphone Actif)`;
  }

  const shopHeading = document.getElementById('merchant-shop-heading');
  const shopSub = document.getElementById('merchant-shop-subtitle');
  if (shopHeading) shopHeading.textContent = m.nom_boutique;
  if (shopSub) {
    shopSub.textContent = `Maître Marchand : ${m.nom_gerant} • Données stockées dans ce téléphone (ID: ${m.id})`;
  }

  document.querySelectorAll('.tab-btn[data-mtab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mtab === merchantState.activeTab);
  });

  if (merchantState.activeTab === 'inventory') {
    root.innerHTML = renderInventoryView();
  } else if (merchantState.activeTab === 'queue') {
    root.innerHTML = renderOrdersQueueView();
  } else if (merchantState.activeTab === 'crm') {
    root.innerHTML = renderCrmWhatsappView();
  } else {
    root.innerHTML = renderGatewaySimulatorView();
  }

  bindMerchantEvents();
  renderThermalSlipModal();
}

function bindAuthEvents() {
  const btnLogin = document.getElementById('btn-switch-login');
  if (btnLogin) {
    btnLogin.onclick = () => {
      merchantState.authMode = 'login';
      merchantState.authError = '';
      renderMerchantDashboard();
    };
  }
  const btnReg = document.getElementById('btn-switch-register');
  if (btnReg) {
    btnReg.onclick = () => {
      merchantState.authMode = 'register';
      merchantState.authError = '';
      renderMerchantDashboard();
    };
  }

  const formLogin = document.getElementById('form-merchant-login');
  if (formLogin) formLogin.onsubmit = handleMerchantLogin;

  const formReg = document.getElementById('form-merchant-register');
  if (formReg) formReg.onsubmit = handleMerchantRegister;

  document.querySelectorAll('[data-quick-login]').forEach((btn) => {
    btn.onclick = () => {
      document.getElementById('login-id').value = btn.dataset.quickLogin;
      document.getElementById('login-pin').value = btn.dataset.quickPin;
      formLogin.requestSubmit();
    };
  });
}

function bindMerchantEvents() {
  const invSearch = document.getElementById('merchant-inv-search');
  if (invSearch) {
    invSearch.oninput = (e) => {
      merchantState.inventorySearch = e.target.value;
      const pos = e.target.selectionStart;
      renderMerchantDashboard();
      const restored = document.getElementById('merchant-inv-search');
      if (restored) {
        restored.focus();
        restored.setSelectionRange(pos, pos);
      }
    };
  }

  // Boutons d'ajustement rapide (-500, +500 FCFA, -10, -1, +1, +10 unités)
  document.querySelectorAll('[data-adj-id]').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.adjId;
      const dPrix = parseInt(btn.dataset.adjPrix || '0', 10);
      const dStock = parseInt(btn.dataset.adjStock || '0', 10);
      quickAdjustArticle(id, dPrix, dStock);
    };
  });

  // Bouton Enregistrer (modification libre de désignation, catégorie, prix ou stock)
  document.querySelectorAll('[data-save-art]').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.saveArt;
      quickAdjustArticle(id, 0, 0);
    };
  });

  // Bouton Supprimer un article
  document.querySelectorAll('[data-del-art]').forEach((btn) => {
    btn.onclick = () => removeMerchantArticle(btn.dataset.delArt);
  });

  const btnExport = document.getElementById('btn-export-json');
  if (btnExport) btnExport.onclick = exportMerchantStockJson;

  const formNewArt = document.getElementById('form-new-article');
  if (formNewArt) formNewArt.onsubmit = createNewArticle;

  document.querySelectorAll('[data-filter-statut]').forEach((btn) => {
    btn.onclick = () => {
      merchantState.statutFilter = btn.dataset.filterStatut;
      renderMerchantDashboard();
    };
  });

  document.querySelectorAll('[data-status-order]').forEach((btn) => {
    btn.onclick = () => {
      changeOrderStatus(btn.dataset.statusOrder, btn.dataset.statusVal);
    };
  });

  document.querySelectorAll('[data-slip-order]').forEach((btn) => {
    btn.onclick = () => {
      const ord = merchantState.orders.find((o) => o.id === btn.dataset.slipOrder);
      if (ord) {
        merchantState.thermalModalOrder = ord;
        renderThermalSlipModal();
      }
    };
  });

  const inpPromo = document.getElementById('inp-promo-msg');
  if (inpPromo) {
    inpPromo.oninput = (e) => {
      merchantState.promoProductText = e.target.value;
      renderMerchantDashboard();
      const restored = document.getElementById('inp-promo-msg');
      if (restored) restored.focus();
    };
  }

  const btnFireSms = document.getElementById('btn-fire-sms');
  if (btnFireSms) btnFireSms.onclick = triggerGatewayWebhook;
}

window.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab-btn[data-mtab]').forEach((btn) => {
    btn.onclick = () => {
      merchantState.activeTab = btn.dataset.mtab;
      renderMerchantDashboard();
    };
  });

  const btnRefresh = document.getElementById('btn-refresh-dashboard');
  if (btnRefresh) btnRefresh.onclick = fetchDashboardData;

  const btnLogout = document.getElementById('btn-logout-merchant');
  if (btnLogout) btnLogout.onclick = logoutMerchant;

  fetchDashboardData();
});
