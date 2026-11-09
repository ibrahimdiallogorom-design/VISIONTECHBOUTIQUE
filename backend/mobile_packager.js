/**
 * SahelExpress - Générateur d'Assets PWA & APK (PWABuilder 100% Compatible)
 * Génère :
 * - media/icon-192.png (192x192 PNG RGBA)
 * - media/icon-512.png (512x512 PNG RGBA)
 * - media/screenshot-mobile.png (540x720 PNG RGBA exigé par PWABuilder)
 * - media/screenshot-wide.png (1280x720 PNG RGBA exigé par PWABuilder)
 * - SahelExpress-Mobile-Offline.html (Fichier portable autonome Bluetooth/WhatsApp)
 */

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcVal = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function generatePngImage(width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rawData = Buffer.alloc(height * (width * 4 + 1));
  const marginX = Math.floor(width * 0.12);
  const marginY = Math.floor(height * 0.12);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    rawData[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      const insideCard =
        x >= marginX && x < width - marginX && y >= marginY && y < height - marginY;

      if (insideCard) {
        rawData[px] = 245;
        rawData[px + 1] = Math.max(90, 158 - Math.floor((y / height) * 60));
        rawData[px + 2] = 11;
        rawData[px + 3] = 255;
      } else {
        rawData[px] = 15;
        rawData[px + 1] = 23;
        rawData[px + 2] = 42;
        rawData[px + 3] = 255;
      }
    }
  }

  const compressed = zlib.deflateSync(rawData, { level: 6 });

  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0))
  ]);
}

function buildMobileAssets() {
  const publicDir = path.join(__dirname, '..', 'public');
  const mediaDir = path.join(publicDir, 'media');
  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }

  // Icônes 192x192 et 512x512
  fs.writeFileSync(path.join(mediaDir, 'icon-192.png'), generatePngImage(192, 192));
  fs.writeFileSync(path.join(mediaDir, 'icon-512.png'), generatePngImage(512, 512));

  // Captures d'écran exigées par PWABuilder pour la génération APK sans avertissement
  fs.writeFileSync(path.join(mediaDir, 'screenshot-mobile.png'), generatePngImage(540, 720));
  fs.writeFileSync(path.join(mediaDir, 'screenshot-wide.png'), generatePngImage(1280, 720));

  // Fichier portable autonome
  const css = fs.readFileSync(path.join(publicDir, 'css', 'styles.css'), 'utf8');
  const dbLocalJs = fs.readFileSync(path.join(publicDir, 'js', 'db_local.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(publicDir, 'js', 'app.js'), 'utf8');

  const standaloneHtml = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes" />
  <meta name="theme-color" content="#d97706" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <title>SahelExpress Mobile (Autonome Hors-Ligne)</title>
  <style>${css}</style>
</head>
<body>
  <div id="network-status-banner" class="status-banner offline">
    <div class="status-indicator">
      <span class="status-dot"></span>
      <span>Application Mobile Autonome SahelExpress</span>
    </div>
  </div>

  <header class="app-header">
    <div class="brand-title">
      <div class="brand-logo">SE</div>
      <div class="brand-text">
        <h1>SahelExpress Mobile</h1>
        <p>Gorom-Gorom • Dori • Sebba • Markoye (100% Hors-Ligne & SMS)</p>
      </div>
    </div>

    <nav class="nav-tabs" aria-label="Navigation Acheteur">
      <button type="button" class="tab-btn active" data-tab="catalog">📦 Catalogue</button>
      <button type="button" class="tab-btn" data-tab="cart">🛒 Panier <span id="nav-cart-badge" class="cart-badge">0</span></button>
      <button type="button" class="tab-btn" data-tab="reviews">⭐ Avis & Suggestions</button>
      <button type="button" class="tab-btn" data-tab="history">📜 Mes Commandes</button>
    </nav>
  </header>

  <main class="main-container" id="app-view-root"></main>
  <div id="bottom-cart-bar" class="bottom-cart-bar" style="display: none;"></div>
  <div id="modal-root"></div>

  <script>${dbLocalJs}</script>
  <script>${appJs}</script>
</body>
</html>`;

  fs.writeFileSync(path.join(publicDir, 'SahelExpress-Mobile-Offline.html'), standaloneHtml, 'utf8');
}

buildMobileAssets();

module.exports = { buildMobileAssets };
