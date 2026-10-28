# Envoi WhatsApp en masse (WasenderAPI)

**Version page web (GitHub Pages)** : `index.html` à la racine, tout tourne dans le navigateur. Ouvrez https://anaslaghezali-ops.github.io/wasenderapi/, collez votre clé API (elle reste dans votre navigateur, jamais dans GitHub), et gardez l’onglet ouvert pendant l’envoi.

La version serveur (`server.js`, décrite ci-dessous) reste disponible si vous voulez que l’envoi continue PC éteint.

Plateforme web pour envoyer un message WhatsApp personnalisé à une liste de numéros, via [WasenderAPI](https://wasenderapi.com).

- Import d’un fichier **Excel/CSV** (ou liste collée). Les numéros `06…`/`07…` sont convertis en `+212…`, doublons et numéros invalides retirés.
- Message personnalisé : `{prenom}` (ou n’importe quelle colonne du fichier) et **variantes au hasard** `{Salut|Bonjour|Hello}`.
- Aperçu, envoi de test à son propre numéro.
- Envoi **lent et irrégulier** (pause aléatoire entre chaque message + grande pause régulière) pour limiter le risque de blocage.
- Suivi en direct, pause / reprise / arrêt, relance des échecs, export CSV des résultats.
- Pause automatique si la session WhatsApp est déconnectée ou après 5 échecs d’affilée.
- Accès protégé par mot de passe.

## ⚠️ Avant d’envoyer

WasenderAPI se connecte à WhatsApp via un QR code (comme WhatsApp Web), pas via l’API officielle de Meta. WhatsApp peut **bannir le numéro** s’il détecte des envois massifs.

- Utilisez un **numéro dédié**, jamais votre numéro principal.
- Commencez petit (50–100 messages/jour les premiers jours), puis augmentez progressivement.
- Écrivez à des personnes qui vous connaissent, avec une option « Répondez STOP ».
- Gardez les pauses par défaut (10–25 s, grande pause de 5 min tous les 40 messages).

## Configuration

| Variable | Rôle |
|---|---|
| `WASENDER_API_KEY` | Clé API de votre session (tableau de bord WasenderAPI) |
| `APP_PASSWORD` | Mot de passe pour se connecter à la plateforme |
| `DRY_RUN=1` | Optionnel : mode simulation, rien n’est envoyé |

**Ne mettez jamais la clé API dans le code** : ce dépôt est public. Saisissez-la uniquement dans les réglages de l’hébergeur ou dans un fichier `.env` (ignoré par Git).

## Mise en ligne

L’envoi tourne sur le serveur : il doit rester allumé pendant toute la campagne (500 messages ≈ 4 h avec les réglages par défaut). Évitez donc les offres gratuites qui mettent le serveur en veille.

Sur n’importe quel hébergeur Node.js (Railway, Render payant, un VPS…) :

1. Connecter ce dépôt GitHub.
2. Commande de démarrage : `npm start` (Node 22 ou plus).
3. Ajouter les variables `WASENDER_API_KEY` et `APP_PASSWORD`.
4. Ajouter un **disque (volume) persistant** et mettre son chemin dans `DATA_DIR`, sinon l’historique des campagnes est perdu à chaque redéploiement.

## En local

```bash
npm install
cp .env.example .env   # puis remplir les valeurs
npm start              # http://localhost:3000
```

Tests (faux serveur WasenderAPI, aucun message réel) : `npm test`.

## Fichier de contacts

Une ligne par contact, une colonne de numéros (`telephone`, `numero`, `tel`, `phone`, `gsm`… ou détectée automatiquement). Toutes les autres colonnes deviennent des variables :

| telephone | prenom | ville |
|---|---|---|
| 0612345678 | Karim | Casablanca |
| +212698765432 | Salma | Rabat |

Message : `{Salut|Bonjour} {prenom}, nouveau restaurant à {ville} !`
