/**
 * SahelExpress - Module Gestion & Dispatch (Tableau de Bord Commerçant / Livreur - Étape 3)
 * Conforme au Chapitre 5.2 du Cahier des Charges :
 * 1. Vue en temps réel des commandes arrivées (Data + SMS unifiés dans une même file)
 * 2. Bouton d'appel téléphonique direct en 1 clic (`tel:...`) vers le client pour confirmation vocale
 * 3. Génération du bon de livraison / préparation simplifiée imprimable en thermique 58mm/80mm
 *    ou visualisable sur smartphone livreur
 * 4. Mise à jour des stocks et push des mises à jour du catalogue (déclenchant le delta `updated_at`)
 * 5. Console Passerelle SMS intégrée pour tester en direct des réceptions SMS `CMD#...`
 */

const merchantState = {
  activeTab: 'queue', // 'queue' | 'inventory' | 'gateway'
  statutFilter: 'ALL', // 'ALL' | 'RECUE' | 'EN_COURS' | 'LIVREE' | 'ANNULEE'
  channelFilter: 'ALL', // 'ALL' | 'SMS' | 'DATA_HTTPS'
  orders: [],
  articles: [],
  catalogHash: '',
  thermalModalOrder: null,
  thermalWidth: '80mm', // '58mm' | '80mm'
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

/**
 * Récupère en temps réel les commandes et l'état du catalogue
 */
async function fetchDashboardData() {
  try {
    const [ordersRes, syncRes] = await Promise.all([
      fetch('/api/orders'),
      fetch('/api/catalog/sync')
    ]);

    if (ordersRes.ok) {
      const oData = await ordersRes.json();
      merchantState.orders = oData.orders || [];
    }
    if (syncRes.ok) {
      const cData = await syncRes.json();
      merchantState.articles = cData.updated_articles || [];
      merchantState.catalogHash = cData.catalog_hash || '';
    }
    renderMerchantDashboard();
  } catch (err) {
    console.warn('[SahelExpress Dispatch] Impossible de joindre le serveur:', err);
  }
}

/**
 * Change le statut d'une commande (RECUE -> EN_COURS -> LIVREE / ANNULEE)
 */
async function changeOrderStatus(orderId, newStatut) {
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statut: newStatut })
    });
    if (res.ok) {
      await fetchDashboardData();
    }
  } catch (err) {
    alert('Erreur lors de la mise à jour du statut.');
  }
}

/**
 * Met à jour le stock et le prix d'un article et déclenche le push Delta (updated_at + hash)
 */
async function updateArticleStockAndPrice(articleId, prixUnitaire, stockDisponible) {
  try {
    const res = await fetch(`/api/articles/${encodeURIComponent(articleId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prix_unitaire: Number(prixUnitaire),
        stock_disponible: Number(stockDisponible)
      })
    });
    if (res.ok) {
      await fetchDashboardData();
    }
  } catch (err) {
    alert('Erreur lors de la mise à jour du stock.');
  }
}

/**
 * Ajoute un nouvel article au catalogue
 */
async function createNewArticle(e) {
  e.preventDefault();
  const id = document.getElementById('new-art-id').value.trim();
  const designation = document.getElementById('new-art-des').value.trim();
  const categorie = document.getElementById('new-art-cat').value;
  const prix = document.getElementById('new-art-prix').value;
  const stock = document.getElementById('new-art-stock').value;

  if (!designation || !prix) return;

  const res = await fetch('/api/articles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: id || undefined,
      designation,
      categorie,
      prix_unitaire: Number(prix),
      stock_disponible: Number(stock || 10)
    })
  });

  if (res.ok) {
    await fetchDashboardData();
  }
}

/**
 * Envoie un SMS de test dans le webhook de la passerelle (`/api/sms/incoming`)
 */
async function triggerGatewayWebhook() {
  const sender = document.getElementById('gw-sender').value.trim();
  const message = document.getElementById('gw-message').value.trim();
  merchantState.gatewayTestSender = sender;
  merchantState.gatewayTestSms = message;

  const res = await fetch('/api/sms/incoming', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: sender, message })
  });

  const data = await res.json();
  merchantState.gatewayLastResponse = {
    httpStatus: res.status,
    ...data
  };
  await fetchDashboardData();
}

/**
 * Rendu de la File de Commandes Unifiée Temps Réel (Data + SMS)
 */
function renderOrdersQueueView() {
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
           Aucune commande dans cette vue.
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
                    ${
                      o.raw_sms_payload
                        ? `<div style="margin-top:8px; padding:6px 10px; background:#090d16; border:1px solid #f97316; border-radius:6px; font-family:monospace; font-size:0.78rem; color:#fde68a;">
                             SMS Brut : ${o.raw_sms_payload}
                           </div>`
                        : ''
                    }
                  </div>

                  <div style="background:var(--bg-main); padding:10px 12px; border-radius:8px; border:1px solid var(--border-color);">
                    <div style="font-size:0.76rem; color:var(--text-muted); font-weight:700; margin-bottom:4px;">
                      ARTICLES À PRÉPARER :
                    </div>
                    ${linesHtml}
                  </div>
                </div>

                <div class="dispatch-actions-bar">
                  <div style="display:flex; gap:8px; flex-wrap:wrap;">
                    <!-- Bouton d'appel téléphonique direct en 1 clic (Exigence 5.2) -->
                    <a href="tel:${cleanTel}" class="btn-call-client">
                      📞 Appeler le Client (${cleanTel})
                    </a>
                    <!-- Bouton Bon de Livraison Thermique 58mm/80mm (Exigence 5.2) -->
                    <button type="button" class="btn-print-slip" data-slip-order="${o.id}">
                      🧾 Bon de Livraison Thermique (58mm / 80mm)
                    </button>
                  </div>

                  <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                    <small style="color:var(--text-muted); font-weight:700;">Statut :</small>
                    <button type="button" class="cat-pill ${o.statut === 'RECUE' ? 'active' : ''}" data-status-order="${o.id}" data-status-val="RECUE">
                      RECUE
                    </button>
                    <button type="button" class="cat-pill ${o.statut === 'EN_COURS' ? 'active' : ''}" data-status-order="${o.id}" data-status-val="EN_COURS">
                      EN_COURS
                    </button>
                    <button type="button" class="cat-pill ${o.statut === 'LIVREE' ? 'active' : ''}" data-status-order="${o.id}" data-status-val="LIVREE">
                      LIVREE
                    </button>
                    <button type="button" class="cat-pill ${o.statut === 'ANNULEE' ? 'active' : ''}" data-status-order="${o.id}" data-status-val="ANNULEE">
                      ANNULEE
                    </button>
                  </div>
                </div>
              </div>
            `;
          })
          .join('');

  return `
    <div class="kpi-grid">
      <div class="kpi-card">
        <small>Total Commandes (Unifiées)</small>
        <div class="kpi-value">${totalOrders}</div>
      </div>
      <div class="kpi-card">
        <small>Commandes Reçues par SMS</small>
        <div class="kpi-value" style="color:#fb923c;">${smsOrdersCount}</div>
      </div>
      <div class="kpi-card">
        <small>À Préparer / En Cours</small>
        <div class="kpi-value" style="color:#fbbf24;">${pendingCount}</div>
      </div>
      <div class="kpi-card">
        <small>Volume d'Affaires (FCFA)</small>
        <div class="kpi-value" style="color:#34d399;">${formatFcfa(revenueTotal)}</div>
      </div>
    </div>

    <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:16px;">
      <div class="category-pills">
        <button type="button" class="cat-pill ${merchantState.statutFilter === 'ALL' ? 'active' : ''}" data-filter-statut="ALL">Tous Statuts</button>
        <button type="button" class="cat-pill ${merchantState.statutFilter === 'RECUE' ? 'active' : ''}" data-filter-statut="RECUE">⏳ RECUE (À préparer)</button>
        <button type="button" class="cat-pill ${merchantState.statutFilter === 'EN_COURS' ? 'active' : ''}" data-filter-statut="EN_COURS">🛵 EN_COURS</button>
        <button type="button" class="cat-pill ${merchantState.statutFilter === 'LIVREE' ? 'active' : ''}" data-filter-statut="LIVREE">✅ LIVREE</button>
      </div>

      <div class="category-pills">
        <button type="button" class="cat-pill ${merchantState.channelFilter === 'ALL' ? 'active' : ''}" data-filter-channel="ALL">📡 Tous Canaux (Data + SMS)</button>
        <button type="button" class="cat-pill ${merchantState.channelFilter === 'SMS' ? 'active' : ''}" data-filter-channel="SMS">📩 SMS Uniquement</button>
        <button type="button" class="cat-pill ${merchantState.channelFilter === 'DATA_HTTPS' ? 'active' : ''}" data-filter-channel="DATA_HTTPS">🌐 Data HTTPS</button>
      </div>
    </div>

    <div class="orders-queue-list">
      ${cardsHtml}
    </div>
  `;
}

/**
 * Rendu de l'onglet Gestion des Stocks & Push Catalogue Delta
 */
function renderInventoryView() {
  const rowsHtml = merchantState.articles
    .map(
      (art) => `
      <div class="cart-item-row" style="flex-wrap:wrap;">
        <div style="flex:1; min-width:220px;">
          <span class="product-code">${art.id}</span>
          <strong style="margin-left:6px;">${art.designation}</strong>
          <div style="font-size:0.78rem; color:var(--text-muted); margin-top:2px;">
            Catégorie: ${art.categorie} • Dernière MàJ Delta: ${formatDateTime(art.updated_at)} • Hash: ${art.photo_hash_md5 || ''}
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <div>
            <small style="display:block; font-size:0.72rem; color:var(--text-muted);">Prix (FCFA)</small>
            <input type="number" class="form-control" style="width:115px; padding:6px 8px;" id="prix-${art.id}" value="${art.prix_unitaire}" />
          </div>
          <div>
            <small style="display:block; font-size:0.72rem; color:var(--text-muted);">Stock Dispo</small>
            <input type="number" class="form-control" style="width:90px; padding:6px 8px;" id="stock-${art.id}" value="${art.stock_disponible}" />
          </div>
          <button type="button" class="btn-primary" style="width:auto; margin-top:14px; padding:8px 14px;" data-save-art="${art.id}">
            💾 Publier Delta
          </button>
        </div>
      </div>
    `
    )
    .join('');

  return `
    <div class="checkout-grid">
      <div class="panel-card">
        <h2>
          <span>📦 Stocks & Prix du Catalogue</span>
          <small style="font-family:monospace; color:var(--accent-amber);">Hash Delta: ${merchantState.catalogHash}</small>
        </h2>
        <p style="font-size:0.84rem; color:var(--text-secondary); margin-bottom:12px;">
          Toute modification met à jour le timestamp <code>updated_at</code> et le <code>catalog_hash</code>. Les téléphones des clients ne téléchargeront que le delta modifié (&lt; 50 Ko).
        </p>
        ${rowsHtml}
      </div>

      <div class="panel-card">
        <h2>➕ Ajouter un Nouvel Article au Catalogue</h2>
        <form id="form-new-article">
          <div class="form-group">
            <label>Code Article Court (pour SMS, ex: PROD50)</label>
            <input type="text" id="new-art-id" class="form-control" placeholder="PROD50" required />
          </div>
          <div class="form-group">
            <label>Désignation complète</label>
            <input type="text" id="new-art-des" class="form-control" placeholder="Ex: Lampe Solaire Murale 30W" required />
          </div>
          <div class="form-group">
            <label>Catégorie</label>
            <select id="new-art-cat" class="form-control">
              <option value="Solaire">Solaire</option>
              <option value="Consommables">Consommables</option>
              <option value="Quincaillerie">Quincaillerie</option>
              <option value="Petit électroménager">Petit électroménager</option>
              <option value="Papeterie">Papeterie</option>
            </select>
          </div>
          <div class="form-group">
            <label>Prix Unitaire (en Francs CFA)</label>
            <input type="number" id="new-art-prix" class="form-control" placeholder="15000" required />
          </div>
          <div class="form-group">
            <label>Stock Initial Disponible</label>
            <input type="number" id="new-art-stock" class="form-control" value="25" required />
          </div>
          <button type="submit" class="btn-primary">
            🚀 Ajouter & Pousser dans la Synchro Delta
          </button>
        </form>
      </div>
    </div>
  `;
}

/**
 * Rendu de l'onglet Passerelle SMS (Simulateur & Test du Décodeur)
 */
function renderGatewaySimulatorView() {
  const resp = merchantState.gatewayLastResponse;
  return `
    <div class="checkout-grid">
      <div class="panel-card">
        <h2>📡 Console Passerelle SMS Locale (GSM / Android Gateway)</h2>
        <p style="font-size:0.88rem; color:var(--text-secondary); margin-bottom:14px;">
          Cette console simule un SMS entrant transmis par l'application <em>SMS Gateway OpenSource</em> installée sur le téléphone Android de la centrale logistique vers <code>POST /api/sms/incoming</code>.
        </p>

        <div class="form-group">
          <label>Numéro GSM Expéditeur (Client)</label>
          <input type="text" id="gw-sender" class="form-control" value="${merchantState.gatewayTestSender}" />
        </div>

        <div class="form-group">
          <label>Chaîne SMS Compactée reçue (Format : CMD#CLIENT#QUARTIER#ART:QTE#PAIEMENT#NOTE)</label>
          <textarea id="gw-message" class="form-control" rows="3" style="font-family:monospace;">${merchantState.gatewayTestSms}</textarea>
        </div>

        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px;">
          <button type="button" class="cat-pill" id="btn-preset-spec">
            📋 Exemple Fiche Technique (CL890)
          </button>
          <button type="button" class="cat-pill" id="btn-preset-messy">
            🧪 Test Espaces & Minuscules (Robustesse)
          </button>
        </div>

        <button type="button" class="btn-primary" id="btn-fire-sms">
          📩 Injecter le SMS dans la Passerelle & Décoder
        </button>
      </div>

      <div class="panel-card">
        <h2>🔍 Résultat du Décodage & Accusé SMS Automatique</h2>
        ${
          !resp
            ? `<p style="color:var(--text-muted);">Cliquez sur « Injecter le SMS » pour observer le parsing, la création de commande et l'accusé de réception SMS généré.</p>`
            : `
              <div style="margin-bottom:12px;">
                <span class="badge-statut ${resp.httpStatus === 201 ? 'LIVREE' : 'RECUE'}">
                  Statut Passerelle : ${resp.status} (HTTP ${resp.httpStatus})
                </span>
              </div>
              ${
                resp.sms_reply
                  ? `<div class="sms-preview-box" style="border-color:#10b981; margin-bottom:12px;">
                       <small style="color:#34d399;">📲 SMS D'ACCUSÉ DE RÉCEPTION RENVOYÉ AU CLIENT :</small>
                       <div class="sms-code-line" style="color:#a7f3d0;">${resp.sms_reply}</div>
                     </div>`
                  : ''
              }
              <pre style="background:#090d16; padding:12px; border-radius:8px; overflow-x:auto; font-size:0.78rem; color:#cbd5e1;">${JSON.stringify(
                resp,
                null,
                2
              )}</pre>
            `
        }
      </div>
    </div>
  `;
}

/**
 * Rendu de la modale Bon de Livraison / Préparation Thermique 58mm / 80mm (Chapitre 5.2)
 */
function renderThermalSlipModal() {
  const modalRoot = document.getElementById('merchant-modal-root');
  if (!modalRoot) return;

  const order = merchantState.thermalModalOrder;
  if (!order) {
    modalRoot.innerHTML = '';
    return;
  }

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
          <h3>🧾 Bon de Préparation / Livraison Thermique</h3>
          <button type="button" class="btn-close" id="btn-close-thermal">✕</button>
        </div>

        <div class="no-print" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; gap:8px;">
          <div style="display:flex; gap:6px;">
            <button type="button" class="cat-pill ${merchantState.thermalWidth === '58mm' ? 'active' : ''}" id="btn-width-58">
              Rouleau 58mm
            </button>
            <button type="button" class="cat-pill ${merchantState.thermalWidth === '80mm' ? 'active' : ''}" id="btn-width-80">
              Rouleau 80mm
            </button>
          </div>
          <button type="button" class="btn-primary" style="width:auto; padding:8px 14px;" id="btn-trigger-print">
            🖨️ Imprimer Ticket
          </button>
        </div>

        <!-- Zone imprimable en thermique 58mm ou 80mm -->
        <div id="thermal-print-area" class="thermal-slip-wrapper width-${merchantState.thermalWidth}">
          <div class="thermal-center">
            <strong style="font-size:1.2em;">SAHEL EXPRESS</strong><br/>
            <span>Centrale Logistique Sahel & Liptako</span><br/>
            <span>Gorom-Gorom • Dori • Sebba</span>
          </div>
          <div class="thermal-divider"></div>
          <div>
            <strong>BON DE LIVRAISON : #${order.id}</strong><br/>
            <span>Date : ${formatDateTime(order.created_at)}</span><br/>
            <span>Canal : ${order.mode_transmission}</span><br/>
            <span>Statut : ${order.statut}</span>
          </div>
          <div class="thermal-divider"></div>
          <div>
            <strong>CLIENT : ${order.client_nom || order.client_id}</strong><br/>
            <span>Tél : ${order.client_telephone || 'N/A'}</span><br/>
            <span>Adresse / Repère :</span><br/>
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
            <tbody>
              ${linesRows}
            </tbody>
          </table>
          <div class="thermal-divider"></div>
          <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:1.15em;">
            <span>NET À PAYER :</span>
            <span>${formatFcfa(order.total_fcfa)}</span>
          </div>
          <div>
            <span>Mode règlement : <strong>${order.mode_paiement}</strong></span>
          </div>
          <div class="thermal-divider"></div>
          <div class="thermal-center">
            <span>Signature Client / Livreur :</span><br/><br/><br/>
            <span>Merci pour votre confiance !</span>
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
  document.getElementById('btn-trigger-print').onclick = () => {
    window.print();
  };
}

/**
 * Rendu global du Tableau de Bord Commerçant / Livreur
 */
function renderMerchantDashboard() {
  document.querySelectorAll('.tab-btn[data-mtab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mtab === merchantState.activeTab);
  });

  const root = document.getElementById('merchant-view-root');
  if (!root) return;

  if (merchantState.activeTab === 'queue') {
    root.innerHTML = renderOrdersQueueView();
  } else if (merchantState.activeTab === 'inventory') {
    root.innerHTML = renderInventoryView();
  } else {
    root.innerHTML = renderGatewaySimulatorView();
  }

  bindMerchantEvents();
  renderThermalSlipModal();
}

function bindMerchantEvents() {
  document.querySelectorAll('[data-filter-statut]').forEach((btn) => {
    btn.onclick = () => {
      merchantState.statutFilter = btn.dataset.filterStatut;
      renderMerchantDashboard();
    };
  });

  document.querySelectorAll('[data-filter-channel]').forEach((btn) => {
    btn.onclick = () => {
      merchantState.channelFilter = btn.dataset.filterChannel;
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

  document.querySelectorAll('[data-save-art]').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.saveArt;
      const prix = document.getElementById(`prix-${id}`).value;
      const stock = document.getElementById(`stock-${id}`).value;
      updateArticleStockAndPrice(id, prix, stock);
    };
  });

  const formNewArt = document.getElementById('form-new-article');
  if (formNewArt) {
    formNewArt.onsubmit = createNewArticle;
  }

  const btnFireSms = document.getElementById('btn-fire-sms');
  if (btnFireSms) {
    btnFireSms.onclick = triggerGatewayWebhook;
  }

  const btnPresetSpec = document.getElementById('btn-preset-spec');
  if (btnPresetSpec) {
    btnPresetSpec.onclick = () => {
      const randQty = Math.floor(1 + Math.random() * 4);
      merchantState.gatewayTestSms = `CMD#CL890#SEC3#PROD01:${randQty};PROD44:1#ESP#PRES_CHATEAU_EAU`;
      renderMerchantDashboard();
    };
  }

  const btnPresetMessy = document.getElementById('btn-preset-messy');
  if (btnPresetMessy) {
    btnPresetMessy.onclick = () => {
      const randQty = Math.floor(1 + Math.random() * 3);
      merchantState.gatewayTestSms = `  cmd # cl102 # dori1 # prod10 : ${randQty} ; prod20 : 2 # om # face_grande_mosquee `;
      renderMerchantDashboard();
    };
  }
}

window.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab-btn[data-mtab]').forEach((btn) => {
    btn.onclick = () => {
      merchantState.activeTab = btn.dataset.mtab;
      renderMerchantDashboard();
    };
  });

  const btnRefresh = document.getElementById('btn-refresh-dashboard');
  if (btnRefresh) {
    btnRefresh.onclick = fetchDashboardData;
  }

  fetchDashboardData();
  // Rafraîchissement temps réel toutes les 4 secondes
  setInterval(fetchDashboardData, 4000);
});
