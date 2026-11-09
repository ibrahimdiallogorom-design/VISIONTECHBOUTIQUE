/**
 * SahelExpress - Authentification par Token JWT Longue Durée
 * Conforme au Chapitre 6.3 du Cahier des Charges :
 * "L'API d'authentification doit fonctionner par token JWT avec expiration longue
 *  pour éviter les déconnexions intempestives."
 *
 * Implémentation HMAC-SHA256 native Node.js (0 dépendance externe)
 * Expiration par défaut : 90 jours (7 776 000 secondes)
 */

const crypto = require('node:crypto');

const JWT_SECRET = process.env.SAHEL_JWT_SECRET || 'sahel-express-liptako-resilient-secret-key-2026';
const DEFAULT_EXP_SECONDS = 90 * 24 * 60 * 60; // 90 jours

function base64UrlEncode(input) {
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Signe un token JWT avec expiration longue (90 jours par défaut)
 */
function signJwt(payload, expiresInSeconds = DEFAULT_EXP_SECONDS) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds
  };

  const encodedHeader = base64UrlEncode(header);
  const encodedPayload = base64UrlEncode(fullPayload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(signingInput)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${signingInput}.${signature}`;
}

/**
 * Vérifie et décode un token JWT
 */
function verifyJwt(token) {
  if (!token || typeof token !== 'string') {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSig = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(signingInput)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  if (signature !== expectedSig) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

module.exports = {
  signJwt,
  verifyJwt,
  DEFAULT_EXP_SECONDS
};
