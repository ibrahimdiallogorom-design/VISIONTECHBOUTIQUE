# SahelExpress — Plateforme E-Commerce Locale & Interurbaine Résiliente (Offline-First / SMS Fallback)

**SahelExpress** est une application e-commerce ultra-résiliente conçue pour les villes et localités du Sahel et du Liptako (*Gorom-Gorom, Dori, Sebba, Markoye, Falagountou*). Elle permet de consulter l'intégralité du catalogue en Francs CFA, constituer un panier et déclencher une commande valide à **100 % hors-ligne**, avec bascule automatique sur un protocole **SMS compacté (`CMD#...`)** en cas de coupure Internet 3G/4G.

---

## Fonctionnalités Principales

1. **Module Acheteur (PWA Offline-First)** :
   - Navigation 100 % hors-ligne via **IndexedDB** et **Service Worker** (`CacheFirst` sur les miniatures WebP `< 15 Ko` et le shell applicatif).
   - Sélection guidée de la Ville et du Secteur (`SEC1` à `SEC5`) + Point de repère connu + Mode de paiement (`Espèces`, `Orange Money`, `Moov Money`).
   - **Moteur d'envoi adaptatif** : tente une requête HTTP POST avec un **timeout strict de 5 secondes**, puis bascule automatiquement vers le service SMS du téléphone (`sms:+22670001122?body=CMD%23...`).
2. **Module Gestion & Dispatch (Tableau de Bord Commerçant / Livreur)** :
   - File de commandes unifiée en temps réel (**Data HTTPS + SMS**).
   - Appel téléphonique client direct en 1 clic (`tel:...`).
   - Générateur de **Bon de Livraison Thermique (`58mm` et `80mm`)** imprimable en 1 clic.
   - Gestion des stocks et des prix avec **Synchronisation Delta** (`updated_at` + `catalog_hash`) et compression **Brotli (`br`) / Gzip (`gzip`)**.
   - **Simulateur de Passerelle SMS intégré**.
3. **Installation Mobile sur les Téléphones** :
   - Installation directe PWA sur l'écran d'accueil Android / iPhone (`/install.html`).
   - Fichier d'application autonome partageable par Bluetooth / WhatsApp (`/SahelExpress-Mobile-Offline.html`).

---

## Démarrage Rapide (Local ou Serveur Cloud)

Prérequis : **Node.js >= 22** (utilise le module natif `node:sqlite`, 0 dépendance externe à installer).

```bash
# Démarrer le serveur sur le port 3000 (ou process.env.PORT)
npm start

# Exécuter les tests automatisés (Backend, PWA et Dashboard Commerçant)
node backend/test_backend.js
node backend/test_phase2_pwa.js
node backend/test_phase3_merchant.js
```

### Liens de l'application :
- **Boutique Acheteur (PWA)** : `http://localhost:3000/`
- **Tableau de Bord Commerçant / Livreur** : `http://localhost:3000/merchant.html`
- **Centre d'Installation Mobile** : `http://localhost:3000/install.html`
- **Fichier Mobile Autonome (Bluetooth/WhatsApp)** : `http://localhost:3000/SahelExpress-Mobile-Offline.html`
