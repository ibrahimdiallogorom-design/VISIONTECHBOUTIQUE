/**
 * SahelExpress - Module Acheteur Multi-Boutiques avec :
 * 1. Écran d'ouverture obligatoire (Onboarding Acheteur : Nom + Numéro WhatsApp + Ville)
 *    pour alimenter la base de données des avis et recevoir les propositions de produits.
 * 2. Filtrage du catalogue par Boutique Commerçant et par Catégorie.
 * 3. Onglet "Avis & Suggestions de Produits" relié à chaque commerçant.
 * 4. Moteur d'envoi adaptatif (Data HTTPS timeout 5s -> Bascule SMS `CMD#...`).
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

const DEFAULT_MERCHANTS = [
  { id: 'M-SAHEL', nom_boutique: 'SahelExpress Centrale (Gorom-Gorom)', ville: 'Gorom-Gorom' },
  { id: 'M-DORI', nom_boutique: 'Faso Quincaillerie & Solaire (Dori)', ville: 'Dori' }
];

const state = {
  activeTab: 'catalog', // 'catalog' | 'cart' | 'reviews' | 'history'
  selectedCategory: 'Toutes',
  selectedMerchantId: 'ALL',
  merchantsList: DEFAULT_MERCHANTS,
  searchQuery: '',
  articles: [],
  cart: [],
  reviews: [],
  localOrders: [],
  isOnline: navigator.onLine,
  simulatedOffline: false,
  logisticsSmsNumber: '+22670001122',
  lastSyncTime: null,
  catalogHash: null,
  selectedProductModal: null,
  lastOrderResultModal: null,
  // Vérifie si l'acheteur a déjà renseigné son Nom et son Numéro WhatsApp à l'ouverture
  buyerOnboarded: Boolean(localStorage.getItem('sahel_buyer_onboarded')),
  showProfileModal: false,
  buyerForm: {
    clientCode: localStorage.getItem('sahel_client_code') || 'CL' + Math.floor(100 + Math.random() * 899),
    nomComplet: localStorage.getItem('sahel_nom') || '',
    whatsapp: localStorage.getItem('sahel_whatsapp') || '',
    telephone: localStorage.getItem('sahel_tel') || '',
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

function saveBuyerFormToStorage() {
  localStorage.setItem('sahel_client_code', state.buyerForm.clientCode);
  localStorage.setItem('sahel_nom', state.buyerForm.nomComplet);
  localStorage.setItem('sahel_whatsapp', state.buyerForm.whatsapp);
  localStorage.setItem('sahel_tel', state.buyerForm.telephone || state.buyerForm.whatsapp);
  localStorage.setItem('sahel_ville', state.buyerForm.ville);
  localStorage.setItem('sahel_quartier', state.buyerForm.quartierCode);
  localStorage.setItem('sahel_repere', state.buyerForm.pointRepere);
  localStorage.setItem('sahel_paiement', state.buyerForm.modePaiement);
}

/**
 * Enregistre le profil Acheteur (Nom + Numéro WhatsApp) à l'ouverture
 * dans le stockage local ET dans la base de données du serveur pour les avis et offres produits
 */
async function completeBuyerOnboarding(e) {
  e.preventDefault();
  const nom = (document.getElementById('onboard-nom').value || '').trim();
  const whatsapp = (document.getElementById('onboard-whatsapp').value || '').trim();
  const ville = document.getElementById('onboard-ville').value || 'Gorom-Gorom';
  const repere = (document.getElementById('onboard-repere').value || '').trim() || 'DOMICILE';

  if (!nom || whatsapp.length < 8) {
    alert('Veuillez entrer votre nom complet et votre numéro de téléphone WhatsApp.');
    return;
  }

  state.buyerForm.nomComplet = nom;
  state.buyerForm.whatsapp = whatsapp;
  state.buyerForm.telephone = whatsapp;
  state.buyerForm.ville = ville;
  state.buyerForm.pointRepere = repere;

  const secteurs = SAHEL_LOCALITES[ville] || SAHEL_LOCALITES['Gorom-Gorom'];
  state.buyerForm.quartierCode = secteurs[0].code;

  saveBuyerFormToStorage();
  localStorage.setItem('sahel_buyer_onboarded', 'true');
  state.buyerOnboarded = true;
  state.showProfileModal = false;

  // Synchroniser le profil acheteur avec le backend s'il est joignable
  if (isEffectiveOnline()) {
    try {
      const res = await fetch('/api/buyers/onboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: state.buyerForm.clientCode,
          nom_complet: nom,
          whatsapp,
          telephone: whatsapp,
          ville,
          secteur_quartier: state.buyerForm.quartierCode,
          point_repere: repere
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.client && data.client.id) {
          state.buyerForm.clientCode = data.client.id;
          saveBuyerFormToStorage();
        }
        if (data.token) {
          localStorage.setItem('sahel_buyer_jwt', data.token);
        }
      }
    } catch {
      // Hors-ligne ou sur GitHub Pages : profil sauvegardé localement, sera transmis à la prochaine commande
    }
  }

  renderApp();
}

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

async function syncCatalogDelta() {
  const store = window.SahelLocalStore;
  const savedHash = await store.getMeta('catalog_hash', '');
  const savedSince = await store.getMeta('last_sync_timestamp', '');

  state.catalogHash = savedHash;
  state.lastSyncTime = savedSince;

  if (!isEffectiveOnline()) {
    state.articles = await store.getAllArticles();
    state.reviews = await store.getLocalReviews();
    renderApp();
    return;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);

    const [syncRes, merchRes, revRes] = await Promise.all([
      fetch(`/api/catalog/sync?since=${encodeURIComponent(savedSince)}&hash=${encodeURIComponent(savedHash)}`, { signal: controller.signal }),
      fetch('/api/merchants/public', { signal: controller.signal }).catch(() => null),
      fetch('/api/reviews', { signal: controller.signal }).catch(() => null)
    ]);

    clearTimeout(timer);

    if (syncRes && syncRes.ok) {
      const data = await syncRes.json();
      if (data.logistics_sms_number) {
        state.logisticsSmsNumber = data.logistics_sms_number;
      }
      if (!data.up_to_date && Array.isArray(data.updated_articles)) {
        await store.applyDeltaSync(data.updated_articles, data.deleted_article_ids || []);
        await store.setMeta('catalog_hash', data.catalog_hash || '');
        await store.setMeta('last_sync_timestamp', data.sync_timestamp || new Date().toISOString());
      }
    }

    if (merchRes && merchRes.ok) {
      const mData = await merchRes.json();
      if (Array.isArray(mData.merchants) && mData.merchants.length > 0) {
        state.merchantsList = mData.merchants;
      }
    }

    if (revRes && revRes.ok) {
      const rData = await revRes.json();
      if (Array.isArray(rData.reviews)) {
        state.reviews = rData.reviews;
      }
    }
  } catch {
    // Fallback local silencieux
  }

  state.articles = await store.getAllArticles();
  if (state.reviews.length === 0) {
    state.reviews = await store.getLocalReviews();
  }
  renderApp();
}

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

async function submitBuyerReview(e) {
  e.preventDefault();
  const commercantId = document.getElementById('rev-merchant').value || 'M-SAHEL';
  const articleId = document.getElementById('rev-article').value || '';
  const note = parseInt(document.getElementById('rev-note').value || '5', 10);
  const commentaire = (document.getElementById('rev-comment').value || '').trim();
  const suggestion = (document.getElementById('rev-suggestion').value || '').trim();

  if (!commentaire && !suggestion) {
    alert('Veuillez écrire votre avis ou le produit que vous aimeriez qu\'on vous propose.');
    return;
  }

  const payload = {
    commercant_id: commercantId,
    article_id: articleId,
    client_id: state.buyerForm.clientCode,
    client_nom: state.buyerForm.nomComplet || 'Client SahelExpress',
    client_whatsapp: state.buyerForm.whatsapp || state.buyerForm.telephone,
    note,
    commentaire,
    suggestion_produit: suggestion,
    created_at: new Date().toISOString()
  };

  await window.SahelLocalStore.saveLocalReview(payload);

  if (isEffectiveOnline()) {
    try {
      await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch {
      // Sauvegardé en local
    }
  }

  state.reviews.unshift(payload);
  renderApp();
  alert('Merci ! Votre avis et votre suggestion ont été enregistrés avec votre numéro WhatsApp.');
}

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

  if (isEffectiveOnline()) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          client: {
            id: state.buyerForm.clientCode,
            telephone: state.buyerForm.whatsapp || state.buyerForm.telephone,
            whatsapp: state.buyerForm.whatsapp || state.buyerForm.telephone,
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
          total_fcfa: totalFcfa,
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
          totalFcfa,
          adresse: result.order.adresse_livraison
        };
        await syncCatalogDelta();
        return;
      }
    } catch {
      console.warn('[SahelExpress] Timeout 5s ou Hors-Ligne -> Bascule SMS.');
    }
  }

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

  try {
    window.location.href = smsHref;
  } catch {}
}

async function simulateGatewaySmsDelivery(smsPayload) {
  try {
    const res = await fetch('/api/sms/incoming', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: state.buyerForm.whatsapp || state.buyerForm.telephone,
        message: smsPayload
      })
    });
    const data = await res.json();
    if (res.ok && data.order) {
      state.lastOrderResultModal.gatewayAck = data.sms_reply;
      state.lastOrderResultModal.confirmedServerId = data.order.id;
      renderApp();
    }
  } catch {
    alert('Serveur injoignable pour la simulation de passerelle.');
  }
}

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
      ${
        state.buyerForm.nomComplet
          ? `<span style="font-size:0.78rem; background:rgba(0,0,0,0.28); padding:3px 8px; border-radius:6px;">
               👋 ${state.buyerForm.nomComplet} (WhatsApp: ${state.buyerForm.whatsapp})
             </span>`
          : ''
      }
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

function renderCatalogView() {
  const query = state.searchQuery.trim().toLowerCase();
  const filtered = state.articles.filter((art) => {
    const matchMerchant =
      state.selectedMerchantId === 'ALL' || art.commercant_id === state.selectedMerchantId;
    const matchCat =
      state.selectedCategory === 'Toutes' || art.categorie === state.selectedCategory;
    const matchQuery =
      !query ||
      art.designation.toLowerCase().includes(query) ||
      art.id.toLowerCase().includes(query) ||
      (art.categorie && art.categorie.toLowerCase().includes(query));
    return matchMerchant && matchCat && matchQuery;
  });

  const merchantPills = [
    `<button type="button" class="cat-pill ${state.selectedMerchantId === 'ALL' ? 'active' : ''}" data-merch="ALL">🏪 Toutes les Boutiques</button>`,
    ...state.merchantsList.map(
      (m) => `
        <button type="button" class="cat-pill ${state.selectedMerchantId === m.id ? 'active' : ''}" data-merch="${m.id}">
          🏪 ${m.nom_boutique}
        </button>
      `
    )
  ].join('');

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
           <p>Aucun article trouvé pour ce filtre.</p>
         </div>`
      : filtered
          .map((art) => {
            const inCart = state.cart.find((c) => c.article_id === art.id);
            const qty = inCart ? inCart.quantite : 0;
            const icon = CATEGORY_ICONS[art.categorie] || '📦';
            const shopName = art.nom_boutique || 'SahelExpress Centrale';

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
                  <div style="margin-top:8px; font-size:0.75rem; color:#34d399; font-weight:700;">
                    🏪 ${shopName}
                  </div>
                  <h3 class="product-title" data-open-product="${art.id}" style="margin-top:4px;">
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
      <div class="category-pills">${merchantPills}</div>
      <div class="category-pills">${pillsHtml}</div>
    </section>
    <section class="products-grid">
      ${cardsHtml}
    </section>
  `;
}

function renderCartView() {
  const totalFcfa = state.cart.reduce((sum, i) => sum + i.prix_unitaire * i.quantite, 0);
  const villes = Object.keys(SAHEL_LOCALITES);
  const secteurs = SAHEL_LOCALITES[state.buyerForm.ville] || SAHEL_LOCALITES['Gorom-Gorom'];

  if (!secteurs.some((s) => s.code === state.buyerForm.quartierCode)) {
    state.buyerForm.quartierCode = secteurs[0].code;
  }

  const smsPreview = generateCompactSmsPayload();

  const cartLinesHtml =
    state.cart.length === 0
      ? `<p style="color: var(--text-muted); padding: 20px 0;">Votre panier est vide. Parcourez le catalogue pour ajouter des articles.</p>`
      : state.cart
          .map(
            (item) => `
          <div class="cart-item-row">
            <div class="cart-item-info">
              <h4>${item.designation}</h4>
              <small>${item.article_id} • ${formatFcfa(item.prix_unitaire)} / unité • 🏪 ${item.nom_boutique || ''}</small>
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
        <h2>📍 Livraison & Coordonnées WhatsApp</h2>
        <div class="form-group">
          <label>Code Client & Numéro WhatsApp</label>
          <div style="display:grid; grid-template-columns: 1fr 1.6fr; gap:8px;">
            <input type="text" id="inp-client-code" class="form-control" value="${state.buyerForm.clientCode}" readonly />
            <input type="tel" id="inp-whatsapp" class="form-control" value="${state.buyerForm.whatsapp}" placeholder="+22670112233" />
          </div>
        </div>

        <div class="form-group">
          <label>Nom complet de l'acheteur</label>
          <input type="text" id="inp-nom" class="form-control" value="${state.buyerForm.nomComplet}" placeholder="Ex: Amadou Dicko" />
        </div>

        <div class="form-group">
          <label>Ville / Localité</label>
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
          <label>Secteur / Quartier</label>
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
          <label>Point de repère connu</label>
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
          <small>📡 APERÇU DU PAYLOAD SMS COMPACTÉ DE SECOURS :</small>
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
 * Rendu de l'onglet Avis Clients & Propositions de Produits
 */
function renderReviewsView() {
  const reviewsHtml =
    state.reviews.length === 0
      ? `<p style="color:var(--text-muted);">Soyez le premier à laisser un avis ou à suggérer un produit !</p>`
      : state.reviews
          .map(
            (r) => `
          <div class="cart-item-row" style="align-items:flex-start; flex-direction:column; gap:6px;">
            <div style="display:flex; justify-content:space-between; width:100%;">
              <strong>👤 ${r.client_nom} <small style="color:#34d399;">(WhatsApp vérifié)</small></strong>
              <span style="color:var(--accent-amber);">${'⭐'.repeat(r.note || 5)}</span>
            </div>
            ${
              r.commentaire
                ? `<p style="font-size:0.9rem; color:var(--text-primary);">« ${r.commentaire} »</p>`
                : ''
            }
            ${
              r.suggestion_produit
                ? `<div style="font-size:0.82rem; color:#fde68a; background:rgba(245,158,11,0.12); padding:6px 10px; border-radius:6px; width:100%;">
                     💡 <strong>Produit demandé au commerçant :</strong> ${r.suggestion_produit}
                   </div>`
                : ''
            }
          </div>
        `
          )
          .join('');

  return `
    <div class="checkout-grid">
      <div class="panel-card">
        <h2>⭐ Donner votre Avis ou Demander un Produit</h2>
        <p style="font-size:0.86rem; color:var(--text-secondary); margin-bottom:14px;">
          Votre avis et vos besoins sont transmis au commerçant choisi avec votre numéro WhatsApp (<strong>${state.buyerForm.whatsapp || 'Non renseigné'}</strong>) afin qu'il puisse vous proposer de nouveaux produits.
        </p>
        <form id="form-buyer-review">
          <div class="form-group">
            <label>Boutique Commerçant concernée</label>
            <select id="rev-merchant" class="form-control">
              ${state.merchantsList
                .map((m) => `<option value="${m.id}">${m.nom_boutique}</option>`)
                .join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Article concerné (Optionnel)</label>
            <select id="rev-article" class="form-control">
              <option value="">-- Avis général sur la boutique --</option>
              ${state.articles
                .map((a) => `<option value="${a.id}">${a.id} — ${a.designation}</option>`)
                .join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Note de satisfaction</label>
            <select id="rev-note" class="form-control">
              <option value="5">⭐⭐⭐⭐⭐ (5/5 - Très satisfait)</option>
              <option value="4">⭐⭐⭐⭐ (4/5 - Satisfait)</option>
              <option value="3">⭐⭐⭐ (3/5 - Moyen)</option>
              <option value="2">⭐⭐ (2/5 - À améliorer)</option>
              <option value="1">⭐ (1/5 - Insatisfait)</option>
            </select>
          </div>
          <div class="form-group">
            <label>Votre avis sur la qualité / livraison</label>
            <textarea id="rev-comment" class="form-control" rows="2" placeholder="Ex: Livraison rapide et produit conforme..."></textarea>
          </div>
          <div class="form-group">
            <label>💡 Quel(s) nouveau(x) produit(s) aimeriez-vous qu'on vous propose sur WhatsApp ?</label>
            <input type="text" id="rev-suggestion" class="form-control" placeholder="Ex: Batterie solaire 100Ah, Sac de farine, Pompe à eau..." />
          </div>
          <button type="submit" class="btn-primary">
            📩 Envoyer mon Avis & ma Suggestion Produit
          </button>
        </form>
      </div>

      <div class="panel-card">
        <h2>💬 Avis Récents & Produits Demandés par les Clients</h2>
        ${reviewsHtml}
      </div>
    </div>
  `;
}

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

function renderModals() {
  const modalContainer = document.getElementById('modal-root');
  if (!modalContainer) return;

  // 1. MODALE D'OUVERTURE OBLIGATOIRE POUR L'ACHETEUR (NOM + NUMÉRO WHATSAPP)
  if (!state.buyerOnboarded || state.showProfileModal) {
    const villes = Object.keys(SAHEL_LOCALITES);
    modalContainer.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal-box" style="max-width:480px; border-width:2px;">
          <div class="modal-header">
            <h3 style="color:var(--accent-amber);">👋 Bienvenue sur SahelExpress</h3>
            ${
              state.buyerOnboarded
                ? `<button type="button" class="btn-close" id="btn-close-onboard">✕</button>`
                : ''
            }
          </div>
          <p style="font-size:0.9rem; color:var(--text-secondary); margin-bottom:14px;">
            Pour accéder au catalogue des boutiques, laisser des avis et recevoir les propositions de produits adaptés à vos besoins, veuillez indiquer votre <strong>Nom</strong> et votre <strong>Numéro WhatsApp</strong> :
          </p>
          <form id="form-buyer-onboard">
            <div class="form-group">
              <label>Votre Nom & Prénom *</label>
              <input
                type="text"
                id="onboard-nom"
                class="form-control"
                value="${state.buyerForm.nomComplet}"
                placeholder="Ex: Amadou Dicko"
                required
              />
            </div>
            <div class="form-group">
              <label>Votre Numéro de Téléphone WhatsApp *</label>
              <input
                type="tel"
                id="onboard-whatsapp"
                class="form-control"
                value="${state.buyerForm.whatsapp}"
                placeholder="Ex: +226 70 11 22 33"
                required
              />
            </div>
            <div class="form-group">
              <label>Votre Ville / Localité</label>
              <select id="onboard-ville" class="form-control">
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
              <label>Point de repère habituel pour vos livraisons</label>
              <input
                type="text"
                id="onboard-repere"
                class="form-control"
                value="${state.buyerForm.pointRepere}"
                placeholder="Ex: Près du Château d'Eau / Face Mosquée"
              />
            </div>
            <button type="submit" class="btn-primary" style="padding:13px; font-size:1rem;">
              ✅ Enregistrer et Ouvrir la Boutique
            </button>
          </form>
        </div>
      </div>
    `;

    document.getElementById('form-buyer-onboard').onsubmit = completeBuyerOnboarding;
    const btnClose = document.getElementById('btn-close-onboard');
    if (btnClose) {
      btnClose.onclick = () => {
        state.showProfileModal = false;
        renderModals();
      };
    }
    return;
  }

  // 2. MODALE FICHE PRODUIT
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
            <small style="color:#34d399;">🏪 Vendu par : ${art.nom_boutique || 'SahelExpress Centrale'}</small>
          </div>
          <h3 style="font-size:1.15rem; margin-bottom:8px;">${art.designation}</h3>
          <div class="product-price-row" style="margin-bottom:16px;">
            <span class="price-fcfa">${formatFcfa(art.prix_unitaire)}</span>
            <span class="stock-badge">Disponibilité : ${art.stock_disponible} en stock</span>
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

  // 3. MODALE RÉSULTAT COMMANDE
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
            <p style="margin-bottom:10px;">Votre commande <strong>#${res.orderId}</strong> d'un montant de <strong style="color:var(--accent-amber);">${formatFcfa(res.totalFcfa)}</strong> a été transmise au commerçant.</p>
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

function renderApp() {
  renderStatusBanner();

  const totalCartItems = state.cart.reduce((sum, i) => sum + i.quantite, 0);
  const totalCartFcfa = state.cart.reduce((sum, i) => sum + i.prix_unitaire * i.quantite, 0);

  const badgeEl = document.getElementById('nav-cart-badge');
  if (badgeEl) badgeEl.textContent = totalCartItems;

  document.querySelectorAll('.tab-btn[data-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === state.activeTab);
  });

  const viewRoot = document.getElementById('app-view-root');
  if (!viewRoot) return;

  if (state.activeTab === 'catalog') {
    viewRoot.innerHTML = renderCatalogView();
  } else if (state.activeTab === 'cart') {
    viewRoot.innerHTML = renderCartView();
  } else if (state.activeTab === 'reviews') {
    viewRoot.innerHTML = renderReviewsView();
  } else {
    viewRoot.innerHTML = renderHistoryView();
  }

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

  document.querySelectorAll('[data-merch]').forEach((btn) => {
    btn.onclick = () => {
      state.selectedMerchantId = btn.dataset.merch;
      renderApp();
    };
  });

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

  bindInput('inp-whatsapp', 'whatsapp');
  bindInput('inp-nom', 'nomComplet');
  bindInput('sel-ville', 'ville', true);
  bindInput('sel-quartier', 'quartierCode');
  bindInput('inp-repere', 'pointRepere');
  bindInput('sel-paiement', 'modePaiement');

  const btnValidate = document.getElementById('btn-validate-order');
  if (btnValidate) {
    btnValidate.onclick = submitAdaptiveOrder;
  }

  const formReview = document.getElementById('form-buyer-review');
  if (formReview) {
    formReview.onsubmit = submitBuyerReview;
  }
}

async function initApp() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch {}
  }

  window.addEventListener('online', () => {
    state.isOnline = true;
    syncCatalogDelta();
  });
  window.addEventListener('offline', () => {
    state.isOnline = false;
    renderApp();
  });

  document.querySelectorAll('.tab-btn[data-tab]').forEach((btn) => {
    btn.onclick = () => {
      state.activeTab = btn.dataset.tab;
      renderApp();
    };
  });

  const btnEditProfile = document.getElementById('btn-edit-buyer-profile');
  if (btnEditProfile) {
    btnEditProfile.onclick = () => {
      state.showProfileModal = true;
      renderModals();
    };
  }

  state.articles = await window.SahelLocalStore.getAllArticles();
  state.cart = await window.SahelLocalStore.getCart();
  state.localOrders = await window.SahelLocalStore.getLocalOrders();
  renderApp();

  await syncCatalogDelta();
}

window.addEventListener('DOMContentLoaded', initApp);
