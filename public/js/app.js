/**
 * SahelExpress - Module Acheteur (Application PWA Offline-First & Moteur d'Envoi Adaptatif)
 * Conforme aux Chapitres 3.1, 3.2, 5.1 et 6 du Cahier des Charges :
 * - Navigation 100% hors-ligne dans le catalogue local (IndexedDB)
 * - Synchronisation par delta (hash + timestamp `updated_at`)
 * - Filtres par catégories (Solaire, Consommables, Quincaillerie, Petit électroménager, Papeterie)
 * - Sélection Ville / Secteur via menu déroulant + Point de repère connu + Mode de paiement
 * - Moteur d'envoi adaptatif : HTTP POST avec timeout de 5 secondes -> Bascule automatique SMS `sms:NUMERO?body=CMD#...`
 */

const CATEGORIES = [
  'Toutes',
  'Solaire',
  'Consommables',
  'Quincaillerie',
  'Petit électroménager',
  'Papeterie'
];

const CATEGORY_ICONS = {
  Solaire: '☀️',
  Consommables: '🌾',
  Quincaillerie: '🛠️',
  'Petit électroménager': '🔌',
  Papeterie: '📚'
};

// Menus déroulants officiels des localités et secteurs du Sahel / Liptako (Chapitre 5.1)
const SAHEL_LOCALITES = {
  'Gorom-Gorom': [
    { code: 'SEC1', label: 'SEC1 - Secteur 1 (Centre / Grand Marché)' },
    { code: 'SEC2', label: 'SEC2 - Secteur 2 (Route de Dori)' },
    { code: 'SEC3', label: 'SEC3 - Secteur 3 (Château d\'Eau)' },
    { code: 'SEC4', label: 'SEC4 - Secteur 4 (Quartier Nord)' },
    { code: 'SEC5', label: 'SEC5 - Secteur 5 (Périphérie Est)' }
  ],
  Dori: [
    { code: 'DORI1', label: 'DORI1 - Secteur 1 (Grande Mosquée)' },
    { code: 'DORI2', label: 'DORI2 - Secteur 2 (Gare Routière)' },
    { code: 'DORI3', label: 'DORI3 - Secteur 3 (Petit Paris)' },
    { code: 'DORI4', label: 'DORI4 - Secteur 4 (Wendou)' }
  ],
  Sebba: [
    { code: 'SEB1', label: 'SEB1 - Secteur 1 (Centre Administratif)' },
    { code: 'SEB2', label: 'SEB2 - Secteur 2 (Quartier Marché)' }
  ],
  Markoye: [
    { code: 'MRK1', label: 'MRK1 - Centre Marché de Bétail' },
    { code: 'MRK2', label: 'MRK2 - Quartier Résidentiel' }
  ],
  Falagountou: [
    { code: 'FLG1', label: 'FLG1 - Centre Falagountou' }
  ]
};

const state = {
  activeTab: 'catalog', // 'catalog' | 'cart' | 'history'
  selectedCategory: 'Toutes',
  searchQuery: '',
  articles: [],
  cart: [],
  localOrders: [],
  isOnline: navigator.onLine,
  simulatedOffline: false, // Permet de tester la bascule SMS en 1 clic
  logisticsSmsNumber: '+22670001122',
  lastSyncTime: null,
  catalogHash: null,
  selectedProductModal: null,
  lastOrderResultModal: null,
  buyerForm: {
    clientCode: localStorage.getItem('sahel_client_code') || 'CL890',
    nomComplet: localStorage.getItem('sahel_nom') || 'Amadou Dicko',
    telephone: localStorage.getItem('sahel_tel') || '+22670112233',
    ville: localStorage.getItem('sahel_ville') || 'Gorom-Gorom',
    quartierCode: localStorage.getItem('sahel_quartier') || 'SEC3',
    pointRepere: localStorage.getItem('sahel_repere') || 'PRES_CHATEAU_EAU',
    modePaiement: localStorage.getItem('sahel_paiement') || 'CASH_DELIVERY'
  }
};

function formatFcfa(amount) {
  return Number(amount || 0).toLocaleString('fr-FR') + ' FCFA';
}

function isEffectiveOnline() {
  return state.isOnline && !state.simulatedOffline;
}

/**
 * Génère la chaîne SMS compactée exactement au format du Chapitre 3.2 :
 * CMD#CODE_CLIENT#QUARTIER_ID#ART:QTE;ART:QTE#PAIEMENT#NOTE_VOCALE_OU_TEXTE
 */
function generateCompactSmsPayload() {
  const shortPay =
    state.buyerForm.modePaiement === 'ORANGE_MONEY'
      ? 'OM'
      : state.buyerForm.modePaiement === 'MOOV_MONEY'
      ? 'MOOV'
      : 'ESP';

  const cleanClient = (state.buyerForm.clientCode || 'CL890')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  const cleanQuartier = (state.buyerForm.quartierCode || 'SEC3')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');

  const cleanNote = (state.buyerForm.pointRepere || 'DOMICILE')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/#/g, '')
    .slice(0, 45);

  const itemsPart =
    state.cart.length > 0
      ? state.cart.map((c) => `${c.article_id}:${c.quantite}`).join(';')
      : 'PROD01:1';

  return `CMD#${cleanClient}#${cleanQuartier}#${itemsPart}#${shortPay}#${cleanNote}`;
}

/**
 * Synchronisation incrémentale du catalogue avec le serveur (Chapitre 3.1)
 */
async function syncCatalogDelta() {
  const store = window.SahelLocalStore;
  const savedHash = await store.getMeta('catalog_hash', '');
  const savedSince = await store.getMeta('last_sync_timestamp', '');

  state.catalogHash = savedHash;
  state.lastSyncTime = savedSince;

  if (!isEffectiveOnline()) {
    state.articles = await store.getAllArticles();
    renderApp();
    return;
  }

  try {
    const url = `/api/catalog/sync?since=${encodeURIComponent(savedSince)}&hash=${encodeURIComponent(savedHash)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      if (data.logistics_sms_number) {
        state.logisticsSmsNumber = data.logistics_sms_number;
      }
      if (!data.up_to_date && Array.isArray(data.updated_articles)) {
        await store.applyDeltaSync(data.updated_articles, data.deleted_article_ids || []);
        await store.setMeta('catalog_hash', data.catalog_hash || '');
        await store.setMeta('last_sync_timestamp', data.sync_timestamp || new Date().toISOString());
        state.catalogHash = data.catalog_hash;
        state.lastSyncTime = data.sync_timestamp;
      }
    }
  } catch (err) {
    // En cas d'erreur réseau, on reste silencieusement sur la base locale IndexedDB
    console.warn('[SahelExpress] Synchro réseau indisponible, utilisation du cache IndexedDB.');
  }

  state.articles = await store.getAllArticles();
  renderApp();
}

/**
 * Ajout ou modification de quantité dans le panier local (IndexedDB)
 */
async function updateCartQuantity(articleId, delta) {
  const article = state.articles.find((a) => a.id === articleId);
  if (!article) return;

  const existing = state.cart.find((c) => c.article_id === articleId);
  const currentQty = existing ? existing.quantite : 0;
  const nextQty = Math.max(0, currentQty + delta);

  await window.SahelLocalStore.setCartItem(article, nextQty);
  state.cart = await window.SahelLocalStore.getCart();
  renderApp();
}

function saveBuyerFormToStorage() {
  localStorage.setItem('sahel_client_code', state.buyerForm.clientCode);
  localStorage.setItem('sahel_nom', state.buyerForm.nomComplet);
  localStorage.setItem('sahel_tel', state.buyerForm.telephone);
  localStorage.setItem('sahel_ville', state.buyerForm.ville);
  localStorage.setItem('sahel_quartier', state.buyerForm.quartierCode);
  localStorage.setItem('sahel_repere', state.buyerForm.pointRepere);
  localStorage.setItem('sahel_paiement', state.buyerForm.modePaiement);
}

/**
 * MOTEUR D'ENVOI ADAPTATIF (Chapitre 5.1) :
 * 1. Tente une requête HTTP POST vers `/api/orders` avec un timeout strict de 5 secondes.
 * 2. Si succès : affiche la confirmation de commande en ligne.
 * 3. Si échec, mode hors-ligne ou timeout (> 5 sec) : bascule automatiquement sur le protocole
 *    SMS compacté (`sms:NUMERO?body=CMD#...`) et permet d'envoyer le SMS.
 */
async function submitAdaptiveOrder() {
  if (state.cart.length === 0) return;
  saveBuyerFormToStorage();

  const totalFcfa = state.cart.reduce((sum, i) => sum + i.prix_unitaire * i.quantite, 0);
  const smsPayload = generateCompactSmsPayload();
  const smsHref = `sms:${state.logisticsSmsNumber}?body=${encodeURIComponent(smsPayload)}`;

  const btnSubmit = document.getElementById('btn-validate-order');
  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.textContent = '⏳ Tentative d\'envoi Data HTTPS (Timeout 5s)...';
  }

  // Si l'utilisateur est en ligne (et n'a pas activé le mode test Hors-Ligne), tenter HTTP POST (5s max)
  if (isEffectiveOnline()) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // Timeout strict 5 secondes

      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          client: {
            id: state.buyerForm.clientCode,
            telephone: state.buyerForm.telephone,
            nom_complet: state.buyerForm.nomComplet,
            ville: state.buyerForm.ville,
            secteur_quartier: state.buyerForm.quartierCode,
            point_repere: state.buyerForm.pointRepere
          },
          mode_transmission: 'DATA_HTTPS',
          mode_paiement: state.buyerForm.modePaiement,
          items: state.cart.map((c) => ({
            article_id: c.article_id,
            quantite: c.quantite
          }))
        })
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const result = await response.json();
        await window.SahelLocalStore.saveLocalOrder({
          id: result.order.id,
          total_fcfa: result.order.total_fcfa,
          mode_transmission: 'DATA_HTTPS',
          statut: result.order.statut,
          adresse_livraison: result.order.adresse_livraison,
          items_count: state.cart.reduce((s, i) => s + i.quantite, 0),
          created_at: result.order.created_at
        });

        await window.SahelLocalStore.clearCart();
        state.cart = [];
        state.localOrders = await window.SahelLocalStore.getLocalOrders();
        state.lastOrderResultModal = {
          mode: 'DATA_HTTPS',
          orderId: result.order.id,
          totalFcfa: result.order.total_fcfa,
          adresse: result.order.adresse_livraison
        };
        await syncCatalogDelta();
        return;
      }
    } catch (err) {
      console.warn('[SahelExpress] Échec ou Timeout (5s) HTTP POST -> Bascule automatique sur SMS Fallback.');
    }
  }

  // BASCULE AUTOMATIQUE SUR LE PROTOCOLE SMS COMPACTÉ (Chapitre 3.2 & 5.1)
  const localSmsOrderId = 'SMS-LOCAL-' + Date.now().toString(36).toUpperCase().slice(-4);
  await window.SahelLocalStore.saveLocalOrder({
    id: localSmsOrderId,
    total_fcfa: totalFcfa,
    mode_transmission: 'SMS',
    statut: 'EN_ATTENTE_SMS',
    adresse_livraison: `${state.buyerForm.ville} - ${state.buyerForm.quartierCode} (${state.buyerForm.pointRepere})`,
    raw_sms_payload: smsPayload,
    items_count: state.cart.reduce((s, i) => s + i.quantite, 0),
    created_at: new Date().toISOString()
  });

  await window.SahelLocalStore.clearCart();
  state.cart = [];
  state.localOrders = await window.SahelLocalStore.getLocalOrders();

  state.lastOrderResultModal = {
    mode: 'SMS_FALLBACK',
    orderId: localSmsOrderId,
    totalFcfa,
    smsPayload,
    smsHref,
    logisticsNumber: state.logisticsSmsNumber
  };

  renderApp();

  // Déclenchement automatique du lien natif Android `sms:NUMERO?body=CMD#...`
  try {
    window.location.href = smsHref;
  } catch {
    // Sur navigateur PC de test, la modale permet de simuler ou copier le SMS en 1 clic
  }
}

/**
 * Permet de simuler directement l'arrivée du SMS sur la passerelle locale depuis la modale de test
 */
async function simulateGatewaySmsDelivery(smsPayload) {
  try {
    const res = await fetch('/api/sms/incoming', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: state.buyerForm.telephone,
        message: smsPayload
      })
    });
    const data = await res.json();
    if (res.ok && data.order) {
      state.lastOrderResultModal.gatewayAck = data.sms_reply;
      state.lastOrderResultModal.confirmedServerId = data.order.id;
      renderApp();
    }
  } catch (err) {
    alert('Serveur injoignable pour la simulation de passerelle.');
  }
}

/**
 * Rendu du bandeau d'état réseau en haut de l'application
 */
function renderStatusBanner() {
  const banner = document.getElementById('network-status-banner');
  if (!banner) return;

  const online = isEffectiveOnline();
  banner.className = `status-banner ${online ? 'online' : 'offline'}`;

  banner.innerHTML = `
    <div class="status-indicator">
      <span class="status-dot"></span>
      <span>${
        online
          ? 'Mode En Ligne — Catalogue synchronisé (Data HTTPS / Wi-Fi actif)'
          : 'Mode Hors-Ligne — Navigation 100% locale & Bascule SMS Automatique active'
      }</span>
    </div>
    <div class="banner-actions">
      <button type="button" class="btn-sim-offline" id="btn-toggle-offline">
        ${
          state.simulatedOffline
            ? '🔌 Repasser en Mode En Ligne'
            : '📡 Tester la Panne Réseau (Mode Hors-Ligne / SMS)'
        }
      </button>
    </div>
  `;

  document.getElementById('btn-toggle-offline').onclick = () => {
    state.simulatedOffline = !state.simulatedOffline;
    renderApp();
  };
}

/**
 * Rendu de l'onglet Catalogue (Recherche locale + Filtres Catégories + Grille Articles)
 */
function renderCatalogView() {
  const query = state.searchQuery.trim().toLowerCase();
  const filtered = state.articles.filter((art) => {
    const matchCat =
      state.selectedCategory === 'Toutes' || art.categorie === state.selectedCategory;
    const matchQuery =
      !query ||
      art.designation.toLowerCase().includes(query) ||
      art.id.toLowerCase().includes(query) ||
      (art.categorie && art.categorie.toLowerCase().includes(query));
    return matchCat && matchQuery;
  });

  const pillsHtml = CATEGORIES.map(
    (cat) => `
      <button type="button" class="cat-pill ${
        state.selectedCategory === cat ? 'active' : ''
      }" data-cat="${cat}">
        ${CATEGORY_ICONS[cat] || '📦'} ${cat}
      </button>
    `
  ).join('');

  const cardsHtml =
    filtered.length === 0
      ? `<div class="panel-card" style="grid-column: 1 / -1; text-align:center; padding: 32px;">
           <p>Aucun article ne correspond à votre recherche locale.</p>
         </div>`
      : filtered
          .map((art) => {
            const inCart = state.cart.find((c) => c.article_id === art.id);
            const qty = inCart ? inCart.quantite : 0;
            const icon = CATEGORY_ICONS[art.categorie] || '📦';

            return `
              <div class="product-card">
                <div>
                  <div class="product-thumb" data-open-product="${art.id}">
                    <span class="thumb-icon">${icon}</span>
                    <div class="thumb-meta">
                      <span class="product-code">${art.id}</span>
                      <span class="product-cat-tag">${art.categorie}</span>
                    </div>
                  </div>
                  <h3 class="product-title" data-open-product="${art.id}" style="margin-top:10px;">
                    ${art.designation}
                  </h3>
                </div>
                <div>
                  <div class="product-price-row">
                    <span class="price-fcfa">${formatFcfa(art.prix_unitaire)}</span>
                    <span class="stock-badge ${art.stock_disponible <= 5 ? 'low' : ''}">
                      Stock: ${art.stock_disponible}
                    </span>
                  </div>
                  <div class="card-actions" style="margin-top:10px;">
                    ${
                      qty === 0
                        ? `<button type="button" class="btn-primary" data-add-id="${art.id}">
                             + Ajouter au panier
                           </button>`
                        : `<div class="qty-stepper">
                             <button type="button" class="qty-btn" data-dec-id="${art.id}">−</button>
                             <span class="qty-val">${qty} au panier</span>
                             <button type="button" class="qty-btn" data-inc-id="${art.id}">+</button>
                           </div>`
                    }
                  </div>
                </div>
              </div>
            `;
          })
          .join('');

  return `
    <section class="controls-bar">
      <div class="search-box">
        <input
          type="search"
          id="catalog-search-input"
          class="search-input"
          placeholder="🔍 Rechercher un article en local (ex: Solaire, Riz, Brouette, PROD01...)"
          value="${state.searchQuery.replace(/"/g, '&quot;')}"
        />
      </div>
      <div class="category-pills">
        ${pillsHtml}
      </div>
    </section>
    <section class="products-grid">
      ${cardsHtml}
    </section>
  `;
}

/**
 * Rendu de l'onglet Panier & Choix de Livraison (Chapitre 5.1)
 */
function renderCartView() {
  const totalFcfa = state.cart.reduce((sum, i) => sum + i.prix_unitaire * i.quantite, 0);
  const villes = Object.keys(SAHEL_LOCALITES);
  const secteurs = SAHEL_LOCALITES[state.buyerForm.ville] || SAHEL_LOCALITES['Gorom-Gorom'];

  // S'assurer que le code quartier fait partie de la ville choisie
  if (!secteurs.some((s) => s.code === state.buyerForm.quartierCode)) {
    state.buyerForm.quartierCode = secteurs[0].code;
  }

  const smsPreview = generateCompactSmsPayload();

  const cartLinesHtml =
    state.cart.length === 0
      ? `<p style="color: var(--text-muted); padding: 20px 0;">Votre panier est vide. Parcourez le catalogue hors-ligne pour ajouter des articles.</p>`
      : state.cart
          .map(
            (item) => `
          <div class="cart-item-row">
            <div class="cart-item-info">
              <h4>${item.designation}</h4>
              <small>${item.article_id} • ${formatFcfa(item.prix_unitaire)} / unité</small>
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
              <div class="qty-stepper" style="width:120px;">
                <button type="button" class="qty-btn" data-dec-id="${item.article_id}">−</button>
                <span class="qty-val">${item.quantite}</span>
                <button type="button" class="qty-btn" data-inc-id="${item.article_id}">+</button>
              </div>
              <strong style="min-width:95px; text-align:right; color:var(--accent-amber);">
                ${formatFcfa(item.prix_unitaire * item.quantite)}
              </strong>
            </div>
          </div>
        `
          )
          .join('');

  return `
    <div class="checkout-grid">
      <div class="panel-card">
        <h2>
          <span>🛒 Récapitulatif du Panier</span>
          <span style="font-size:0.85rem; color:var(--text-muted);">${state.cart.length} réf.</span>
        </h2>
        ${cartLinesHtml}
        <div class="cart-summary-total">
          <span>Total Net à Payer :</span>
          <span>${formatFcfa(totalFcfa)}</span>
        </div>
      </div>

      <div class="panel-card">
        <h2>📍 Livraison & Paiement (Sahel / Liptako)</h2>
        <div class="form-group">
          <label>Code Client & Téléphone</label>
          <div style="display:grid; grid-template-columns: 1fr 1.6fr; gap:8px;">
            <input type="text" id="inp-client-code" class="form-control" value="${state.buyerForm.clientCode}" placeholder="Ex: CL890" />
            <input type="tel" id="inp-telephone" class="form-control" value="${state.buyerForm.telephone}" placeholder="+22670112233" />
          </div>
        </div>

        <div class="form-group">
          <label>Nom complet du client</label>
          <input type="text" id="inp-nom" class="form-control" value="${state.buyerForm.nomComplet}" placeholder="Ex: Amadou Dicko" />
        </div>

        <div class="form-group">
          <label>Ville / Localité (Menu déroulant anti-faute de frappe)</label>
          <select id="sel-ville" class="form-control">
            ${villes
              .map(
                (v) =>
                  `<option value="${v}" ${
                    state.buyerForm.ville === v ? 'selected' : ''
                  }>${v}</option>`
              )
              .join('')}
          </select>
        </div>

        <div class="form-group">
          <label>Secteur / Quartier (Normalisé pour SMS)</label>
          <select id="sel-quartier" class="form-control">
            ${secteurs
              .map(
                (s) =>
                  `<option value="${s.code}" ${
                    state.buyerForm.quartierCode === s.code ? 'selected' : ''
                  }>${s.label}</option>`
              )
              .join('')}
          </select>
        </div>

        <div class="form-group">
          <label>Point de repère connu (Ex: Près du château d'eau, Face mosquée)</label>
          <input type="text" id="inp-repere" class="form-control" value="${state.buyerForm.pointRepere}" placeholder="Ex: PRES_CHATEAU_EAU" />
        </div>

        <div class="form-group">
          <label>Mode de Paiement</label>
          <select id="sel-paiement" class="form-control">
            <option value="CASH_DELIVERY" ${state.buyerForm.modePaiement === 'CASH_DELIVERY' ? 'selected' : ''}>
              💵 Espèces à la livraison (Code SMS: ESP)
            </option>
            <option value="ORANGE_MONEY" ${state.buyerForm.modePaiement === 'ORANGE_MONEY' ? 'selected' : ''}>
              🟠 Orange Money (Code SMS: OM)
            </option>
            <option value="MOOV_MONEY" ${state.buyerForm.modePaiement === 'MOOV_MONEY' ? 'selected' : ''}>
              🔵 Moov Money (Code SMS: MOOV)
            </option>
          </select>
        </div>

        <div class="sms-preview-box">
          <small>📡 APERÇU DU PAYLOAD SMS COMPACTÉ DE SECOURS (SI HORS-LIGNE) :</small>
          <div class="sms-code-line" id="live-sms-preview">${smsPreview}</div>
        </div>

        <button
          type="button"
          id="btn-validate-order"
          class="btn-primary"
          style="margin-top:16px; padding:14px; font-size:1rem;"
          ${state.cart.length === 0 ? 'disabled' : ''}
        >
          ${
            isEffectiveOnline()
              ? '🚀 Valider la Commande (Envoi Data 5s ou Bascule SMS)'
              : '📩 Valider Hors-Ligne via SMS Compacté (' + formatFcfa(totalFcfa) + ')'
          }
        </button>
      </div>
    </div>
  `;
}

/**
 * Rendu de l'onglet Historique des Commandes Locales
 */
function renderHistoryView() {
  if (state.localOrders.length === 0) {
    return `
      <div class="panel-card" style="text-align:center; padding:32px;">
        <p style="color:var(--text-muted);">Aucune commande enregistrée sur ce téléphone pour le moment.</p>
      </div>
    `;
  }

  return `
    <div class="panel-card">
      <h2>📜 Historique Local de vos Commandes (IndexedDB)</h2>
      ${state.localOrders
        .map(
          (o) => `
        <div class="cart-item-row">
          <div>
            <h4>Commande #${o.id} — <span style="color:var(--accent-amber);">${formatFcfa(o.total_fcfa)}</span></h4>
            <small>${o.adresse_livraison || ''}</small>
            ${
              o.raw_sms_payload
                ? `<div style="font-family:monospace; font-size:0.76rem; color:#fde68a; margin-top:4px;">SMS: ${o.raw_sms_payload}</div>`
                : ''
            }
          </div>
          <div style="text-align:right;">
            <span class="product-code">${o.mode_transmission}</span>
            <span class="product-cat-tag">${o.statut}</span>
          </div>
        </div>
      `
        )
        .join('')}
    </div>
  `;
}

/**
 * Rendu des fenêtres modales (Fiche Produit détaillée & Résultat de Commande / Bascule SMS)
 */
function renderModals() {
  const modalContainer = document.getElementById('modal-root');
  if (!modalContainer) return;

  if (state.selectedProductModal) {
    const art = state.selectedProductModal;
    const icon = CATEGORY_ICONS[art.categorie] || '📦';
    modalContainer.innerHTML = `
      <div class="modal-backdrop" id="close-modal-backdrop">
        <div class="modal-box" onclick="event.stopPropagation()">
          <div class="modal-header">
            <span class="product-code">${art.id} • ${art.categorie}</span>
            <button type="button" class="btn-close" id="btn-close-modal">✕</button>
          </div>
          <div style="text-align:center; padding: 18px; background: var(--bg-main); border-radius:12px; margin-bottom:14px;">
            <div style="font-size:3.6rem;">${icon}</div>
            <small style="color:var(--text-muted);">Miniature WebP Locale (${art.photo_url}) • Hash MD5: ${art.photo_hash_md5 || 'local'}</small>
          </div>
          <h3 style="font-size:1.15rem; margin-bottom:8px;">${art.designation}</h3>
          <div class="product-price-row" style="margin-bottom:16px;">
            <span class="price-fcfa">${formatFcfa(art.prix_unitaire)}</span>
            <span class="stock-badge">Disponibilité indicative : ${art.stock_disponible} en stock</span>
          </div>
          <button type="button" class="btn-primary" id="btn-modal-add">
            + Ajouter au panier (${formatFcfa(art.prix_unitaire)})
          </button>
        </div>
      </div>
    `;

    document.getElementById('btn-close-modal').onclick = () => {
      state.selectedProductModal = null;
      renderModals();
    };
    document.getElementById('close-modal-backdrop').onclick = () => {
      state.selectedProductModal = null;
      renderModals();
    };
    document.getElementById('btn-modal-add').onclick = async () => {
      await updateCartQuantity(art.id, 1);
      state.selectedProductModal = null;
      renderModals();
    };
    return;
  }

  if (state.lastOrderResultModal) {
    const res = state.lastOrderResultModal;
    if (res.mode === 'DATA_HTTPS') {
      modalContainer.innerHTML = `
        <div class="modal-backdrop">
          <div class="modal-box">
            <div class="modal-header">
              <h3 style="color:#34d399;">✅ Commande Transmise en Ligne (Data HTTPS)</h3>
              <button type="button" class="btn-close" id="btn-close-res-modal">✕</button>
            </div>
            <p style="margin-bottom:10px;">Votre commande <strong>#${res.orderId}</strong> d'un montant de <strong style="color:var(--accent-amber);">${formatFcfa(res.totalFcfa)}</strong> a été reçue instantanément par la centrale logistique.</p>
            <p style="font-size:0.86rem; color:var(--text-secondary); margin-bottom:16px;">📍 Livraison : ${res.adresse}</p>
            <button type="button" class="btn-primary" id="btn-ok-res-modal">Parfait, revenir au catalogue</button>
          </div>
        </div>
      `;
    } else {
      modalContainer.innerHTML = `
        <div class="modal-backdrop">
          <div class="modal-box">
            <div class="modal-header">
              <h3 style="color:#fb923c;">📡 Bascule SMS Automatique Activée</h3>
              <button type="button" class="btn-close" id="btn-close-res-modal">✕</button>
            </div>
            <p style="font-size:0.9rem; margin-bottom:10px;">
              L'absence de connexion Internet (ou le dépassement du délai de 5s) a déclenché le <strong>Protocole SMS Compacté</strong> vers le numéro central <strong>${res.logisticsNumber}</strong> :
            </p>
            <div class="sms-preview-box" style="margin-bottom:12px;">
              <small>CHAÎNE SMS GÉNÉRÉE :</small>
              <div class="sms-code-line">${res.smsPayload}</div>
            </div>
            ${
              res.gatewayAck
                ? `<div style="padding:10px; background:var(--online-bg); border:1px solid #34d399; border-radius:8px; margin-bottom:12px; font-size:0.84rem; color:#a7f3d0;">
                     <strong>✅ Accusé de réception de la Passerelle SMS :</strong><br/>
                     ${res.gatewayAck}
                   </div>`
                : ''
            }
            <div style="display:flex; flex-direction:column; gap:8px;">
              <a href="${res.smsHref}" class="btn-primary" style="text-align:center; text-decoration:none; display:block;">
                📲 Ouvrir l'application SMS Android (${res.logisticsNumber})
              </a>
              <button type="button" class="btn-sim-offline" id="btn-sim-gateway" style="padding:10px; font-size:0.85rem; background:#1e293b; border-color:var(--accent-amber); color:var(--accent-amber);">
                🧪 Simuler la réception immédiate par la Passerelle SMS du Serveur
              </button>
              <button type="button" class="btn-sim-offline" id="btn-ok-res-modal" style="padding:8px;">
                Fermer
              </button>
            </div>
          </div>
        </div>
      `;
    }

    const closeFn = () => {
      state.lastOrderResultModal = null;
      renderModals();
    };
    document.getElementById('btn-close-res-modal').onclick = closeFn;
    document.getElementById('btn-ok-res-modal').onclick = closeFn;
    const simBtn = document.getElementById('btn-sim-gateway');
    if (simBtn) {
      simBtn.onclick = () => simulateGatewaySmsDelivery(res.smsPayload);
    }
    return;
  }

  modalContainer.innerHTML = '';
}

/**
 * Rendu global de l'application Acheteur
 */
function renderApp() {
  renderStatusBanner();

  const totalCartItems = state.cart.reduce((sum, i) => sum + i.quantite, 0);
  const totalCartFcfa = state.cart.reduce((sum, i) => sum + i.prix_unitaire * i.quantite, 0);

  // Mise à jour des badges dans la navigation
  const badgeEl = document.getElementById('nav-cart-badge');
  if (badgeEl) badgeEl.textContent = totalCartItems;

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === state.activeTab);
  });

  const viewRoot = document.getElementById('app-view-root');
  if (!viewRoot) return;

  if (state.activeTab === 'catalog') {
    viewRoot.innerHTML = renderCatalogView();
  } else if (state.activeTab === 'cart') {
    viewRoot.innerHTML = renderCartView();
  } else {
    viewRoot.innerHTML = renderHistoryView();
  }

  // Barre flottante panier en bas d'écran lorsqu'on navigue dans le catalogue
  const bottomBar = document.getElementById('bottom-cart-bar');
  if (bottomBar) {
    if (state.activeTab === 'catalog' && totalCartItems > 0) {
      bottomBar.style.display = 'flex';
      bottomBar.innerHTML = `
        <div class="bottom-cart-info">
          <span>🛒 <strong>${totalCartItems} article(s)</strong> dans votre panier</span><br/>
          <span>Total : <strong>${formatFcfa(totalCartFcfa)}</strong></span>
        </div>
        <button type="button" class="btn-primary" style="width:auto; padding:10px 18px;" id="btn-goto-cart">
          Commander →
        </button>
      `;
      document.getElementById('btn-goto-cart').onclick = () => {
        state.activeTab = 'cart';
        renderApp();
      };
    } else {
      bottomBar.style.display = 'none';
    }
  }

  bindViewEvents();
  renderModals();
}

/**
 * Attache les événements interactifs de la vue courante
 */
function bindViewEvents() {
  const searchInput = document.getElementById('catalog-search-input');
  if (searchInput) {
    searchInput.oninput = (e) => {
      state.searchQuery = e.target.value;
      const cursorPos = e.target.selectionStart;
      renderApp();
      const restored = document.getElementById('catalog-search-input');
      if (restored) {
        restored.focus();
        restored.setSelectionRange(cursorPos, cursorPos);
      }
    };
  }

  document.querySelectorAll('[data-cat]').forEach((btn) => {
    btn.onclick = () => {
      state.selectedCategory = btn.dataset.cat;
      renderApp();
    };
  });

  document.querySelectorAll('[data-add-id]').forEach((btn) => {
    btn.onclick = () => updateCartQuantity(btn.dataset.addId, 1);
  });

  document.querySelectorAll('[data-inc-id]').forEach((btn) => {
    btn.onclick = () => updateCartQuantity(btn.dataset.incId, 1);
  });

  document.querySelectorAll('[data-dec-id]').forEach((btn) => {
    btn.onclick = () => updateCartQuantity(btn.dataset.decId, -1);
  });

  document.querySelectorAll('[data-open-product]').forEach((el) => {
    el.onclick = () => {
      const art = state.articles.find((a) => a.id === el.dataset.openProduct);
      if (art) {
        state.selectedProductModal = art;
        renderModals();
      }
    };
  });

  // Événements du formulaire Panier & Livraison
  const bindInput = (id, key, refreshView = false) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.oninput = (e) => {
      state.buyerForm[key] = e.target.value;
      saveBuyerFormToStorage();
      if (refreshView) {
        renderApp();
      } else {
        const previewEl = document.getElementById('live-sms-preview');
        if (previewEl) previewEl.textContent = generateCompactSmsPayload();
      }
    };
  };

  bindInput('inp-client-code', 'clientCode');
  bindInput('inp-telephone', 'telephone');
  bindInput('inp-nom', 'nomComplet');
  bindInput('sel-ville', 'ville', true);
  bindInput('sel-quartier', 'quartierCode');
  bindInput('inp-repere', 'pointRepere');
  bindInput('sel-paiement', 'modePaiement');

  const btnValidate = document.getElementById('btn-validate-order');
  if (btnValidate) {
    btnValidate.onclick = submitAdaptiveOrder;
  }
}

/**
 * Initialisation au démarrage de la PWA
 */
async function initApp() {
  // Enregistrement du Service Worker Offline-First
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js');
    } catch (err) {
      console.warn('Service Worker non enregistré:', err);
    }
  }

  // Écouteurs temps réel de l'état de connexion du téléphone
  window.addEventListener('online', () => {
    state.isOnline = true;
    syncCatalogDelta();
  });
  window.addEventListener('offline', () => {
    state.isOnline = false;
    renderApp();
  });

  // Navigation par onglets
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.onclick = () => {
      state.activeTab = btn.dataset.tab;
      renderApp();
    };
  });

  // Chargement initial immédiat depuis IndexedDB (0 latence) puis synchro Delta
  state.articles = await window.SahelLocalStore.getAllArticles();
  state.cart = await window.SahelLocalStore.getCart();
  state.localOrders = await window.SahelLocalStore.getLocalOrders();
  renderApp();

  await syncCatalogDelta();
}

window.addEventListener('DOMContentLoaded', initApp);
