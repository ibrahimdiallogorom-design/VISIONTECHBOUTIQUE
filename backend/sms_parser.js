/**
 * SahelExpress - Décodeur & Parser Robuste de Commandes SMS
 * Conforme aux Chapitres 3.2 et 6.4 du Cahier des Charges :
 * Format officiel : CMD#CODE_CLIENT#QUARTIER_ID#ART:QTE;ART:QTE#PAIEMENT#NOTE_VOCALE_OU_TEXTE
 * Exemple : CMD#CL890#SEC3#PROD01:2;PROD44:1#ESP#PRES_CHATEAU_EAU
 *
 * Robustesse :
 * - Nettoyage des espaces accidentels
 * - Insensible à la casse (minuscules/majuscules acceptées)
 * - Mapping intelligent des codes de paiement (ESP, OM, MOOV, CASH_DELIVERY, etc.)
 * - Protection anti-doublons (Idempotence sur fenêtre de 15 minutes)
 */

const crypto = require('node:crypto');

const PAYMENT_MAP = {
  ESP: 'CASH_DELIVERY',
  ESPECE: 'CASH_DELIVERY',
  ESPECES: 'CASH_DELIVERY',
  CASH: 'CASH_DELIVERY',
  CASH_DELIVERY: 'CASH_DELIVERY',
  OM: 'ORANGE_MONEY',
  ORANGE: 'ORANGE_MONEY',
  ORANGE_MONEY: 'ORANGE_MONEY',
  MOOV: 'MOOV_MONEY',
  MOOV_MONEY: 'MOOV_MONEY'
};

/**
 * Parse une chaîne SMS brute au format SahelExpress
 * @param {string} rawText - Texte brut reçu par la passerelle SMS
 * @returns {object} Structure normalisée ou erreur explicite
 */
function parseCompactSms(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { valid: false, error: 'Contenu SMS vide ou invalide.' };
  }

  // Nettoyage des espaces superflus en début/fin et retours à la ligne
  const cleaned = rawText.trim().replace(/\r?\n/g, ' ');

  // Découpage par '#'
  const parts = cleaned.split('#').map((p) => p.trim());

  if (parts.length < 5) {
    return {
      valid: false,
      error: `Format SMS incomplet (${parts.length} segments trouvés, minimum 5 attendus : CMD#CLIENT#QUARTIER#ARTICLES#PAIEMENT#NOTE).`
    };
  }

  const prefix = parts[0].toUpperCase().replace(/\s+/g, '');
  if (prefix !== 'CMD') {
    return {
      valid: false,
      error: `Préfixe invalide "${parts[0]}". Le SMS doit commencer par "CMD#".`
    };
  }

  const clientCode = parts[1].toUpperCase().replace(/\s+/g, '');
  const quartierId = parts[2].toUpperCase().trim();
  const itemsRaw = parts[3].trim();
  const paymentRaw = parts[4].toUpperCase().replace(/\s+/g, '');
  const noteRepere = parts.slice(5).join(' - ').replace(/_/g, ' ').trim() || 'Aucun repère précisé';

  if (!clientCode) {
    return { valid: false, error: 'Code client manquant dans le SMS.' };
  }

  // Parsing de la liste d'articles (ex: "PROD01:2;PROD44:1" ou avec virgules/espaces accidentels)
  const itemTokens = itemsRaw
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (itemTokens.length === 0) {
    return { valid: false, error: 'Aucun article spécifié dans le segment articles.' };
  }

  const parsedItems = [];
  for (const token of itemTokens) {
    const [rawArtId, rawQty] = token.split(':').map((s) => (s ? s.trim() : ''));
    const articleId = (rawArtId || '').toUpperCase().replace(/\s+/g, '');
    const quantite = parseInt(rawQty || '1', 10);

    if (!articleId || Number.isNaN(quantite) || quantite <= 0) {
      return {
        valid: false,
        error: `Couple Article:Quantité invalide ("${token}"). Format attendu: ART:QTE (ex: PROD01:2).`
      };
    }

    // Fusionner si le même article est répété dans le SMS
    const existing = parsedItems.find((i) => i.article_id === articleId);
    if (existing) {
      existing.quantite += quantite;
    } else {
      parsedItems.push({ article_id: articleId, quantite });
    }
  }

  const modePaiement = PAYMENT_MAP[paymentRaw] || 'CASH_DELIVERY';

  // Calcul d'une empreinte anti-doublon normalisée (fenêtre de 15 minutes)
  const timeBucket15Min = Math.floor(Date.now() / (15 * 60 * 1000));
  const canonicalItems = parsedItems
    .map((i) => `${i.article_id}:${i.quantite}`)
    .sort()
    .join(';');
  const dedupSignature = `${clientCode}|${quartierId}|${canonicalItems}|${modePaiement}|${timeBucket15Min}`;
  const dedupHash = crypto.createHash('sha256').update(dedupSignature).digest('hex');

  return {
    valid: true,
    client_code: clientCode,
    quartier_id: quartierId,
    items: parsedItems,
    mode_paiement: modePaiement,
    note_repere: noteRepere,
    raw_sms: cleaned,
    dedup_hash: dedupHash
  };
}

/**
 * Construit un payload SMS compacté à partir d'une commande côté client
 */
function buildCompactSms({ clientCode, quartierId, items, modePaiement, noteRepere }) {
  const shortPay =
    modePaiement === 'ORANGE_MONEY'
      ? 'OM'
      : modePaiement === 'MOOV_MONEY'
      ? 'MOOV'
      : 'ESP';

  const cleanQuartier = (quartierId || 'SEC1').split(' ')[0].toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const cleanNote = (noteRepere || 'DOMICILE')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/#/g, '')
    .slice(0, 45);

  const itemsSegment = items.map((i) => `${i.article_id}:${i.quantite}`).join(';');
  return `CMD#${clientCode || 'CL000'}#${cleanQuartier}#${itemsSegment}#${shortPay}#${cleanNote}`;
}

module.exports = {
  parseCompactSms,
  buildCompactSms
};
