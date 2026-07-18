# 🚜 ShareMate

Application de gestion collective de matériel partagé pour un petit groupe (2 à 5 voisins/amis) :
minipelle, véhicule utilitaire, bétonnière… Réservations, suivi d'usage, alertes d'entretien et
partage des frais façon Tricount.

## Fonctionnalités (MVP)

- **Équipements** : CRUD complet (nom, catégorie, date d'acquisition, valeur d'achat, membres ayant
  accès, type de compteur heures/km). Un équipement appartient au groupe, pas à un propriétaire unique.
- **Réservations** : calendrier de créneaux par équipement, détection de conflit (409 en cas de
  chevauchement), vue calendrier partagée du groupe.
- **Suivi d'usage** : à chaque fin d'utilisation, saisie du relevé de compteur, carburant ajouté et
  remarques ; historique par équipement et par membre ; **alertes d'entretien** dès qu'un seuil
  d'heures/km est dépassé depuis la dernière maintenance déclarée.
- **Frais partagés** : dépenses (achat, assurance, carburant, entretien, réparation) avec justificatif
  image/PDF optionnel ; répartition **par parts égales**, **au prorata du temps d'usage** (calculé à
  partir des réservations) ou **montants personnalisés** ; soldes « qui doit combien à qui » avec
  **minimisation du nombre de transactions** ; historique des remboursements déclarés.

## Architecture

DDD + architecture hexagonale, TypeScript de bout en bout, développé en TDD strict.

```
server/src/
├── domain/           # Entités, value objects, règles métier pures — AUCUNE dépendance externe
│   ├── shared/       # Money (centimes entiers), TimeRange (fin exclusive), erreurs métier
│   ├── group/        # Group, Member
│   ├── equipment/    # Equipment (compteur heures/km, seuil d'entretien)
│   ├── reservation/  # Reservation + règle de non-chevauchement
│   ├── usage/        # UsageRecord + calcul des alertes de maintenance
│   └── expense/      # Expense (règles de répartition), Reimbursement,
│                     # calcul des soldes + minimisation des transactions (type Tricount)
├── application/      # Use cases + ports (interfaces des repositories, Clock, IdGenerator)
└── infrastructure/   # Adapters : SQLite (better-sqlite3), HTTP (Fastify), uploads
web/                  # Front React (Vite) — adapter de présentation
```

Les frontières sont vérifiées par ESLint : le domaine ne peut rien importer des couches
application/infrastructure, l'application ne peut pas importer l'infrastructure.

**Choix notables**

- Les montants sont des **centimes entiers** (`Money`) ; les répartitions utilisent la méthode des
  plus forts restes — pas un centime perdu.
- Les créneaux sont des intervalles **à fin exclusive** : deux réservations adjacentes ne se
  chevauchent pas.
- Le relevé de compteur est **monotone** : un relevé inférieur au dernier connu est refusé.
- Pas d'authentification au MVP (groupe de confiance) : chaque utilisateur choisit son profil.

## Développement

```bash
npm install
npm test              # 171 tests (domaine, application, intégration SQLite + HTTP)
npm run test:coverage # Tests + seuils de couverture (90 % lignes/fonctions, 85 % branches)
npm run lint          # ESLint (frontières hexagonales + règles React hooks)
npm run format        # Prettier (format:check en CI)
npm run typecheck     # tsc sur les deux workspaces
npm run audit:prod    # npm audit des dépendances de production (high+)
npm run dev:server    # API sur http://localhost:3000
npm run dev:web       # Front Vite sur http://localhost:5173 (proxy /api → 3000)
npm run build         # Build de production (server/dist + web/dist)
npm start             # Sert l'API + le front buildé
```

Variables d'environnement du serveur :

| Variable        | Défaut                       | Rôle                                                    |
| --------------- | ---------------------------- | ------------------------------------------------------- |
| `PORT`          | `3000`                       | Port HTTP                                               |
| `DATA_DIR`      | `./data`                     | Répertoire des données persistantes                     |
| `DATABASE_PATH` | `$DATA_DIR/sharemate.sqlite` | Fichier SQLite                                          |
| `UPLOADS_DIR`   | `$DATA_DIR/uploads`          | Justificatifs uploadés                                  |
| `WEB_DIST_DIR`  | `../web/dist`                | Front statique servi par le serveur                     |
| `NODE_ENV`      | —                            | `production` : cookie `Secure`, `trustProxy`, logs JSON |

## Sécurité

- **Sessions** : cookies `httpOnly` + `SameSite=Lax` (+ `Secure` en production), tokens hachés en
  base, mots de passe en scrypt avec comparaison à temps constant.
- **Headers** : `@fastify/helmet` (CSP `default-src 'self'`, `frame-ancestors 'none'`,
  `nosniff`, HSTS…).
- **Rate-limit** : anti force-brute sur les routes d'authentification (10 req/min/IP,
  `trustProxy` activé en production pour identifier la vraie IP derrière le proxy Railway).
- **Logs** : pino JSON en production, en-têtes `cookie`/`set-cookie` expurgés.
- **Conteneur** : image non-root (`USER node`), `HEALTHCHECK` intégré.
- **Chaîne d'appro** : audit npm en CI (bloquant à partir de high), CodeQL hebdomadaire,
  Dependabot (npm, GitHub Actions, image Docker de base).

## Déploiement sur Railway

Le dépôt contient un `Dockerfile` multi-stage et un `railway.json` (healthcheck sur `/api/health`).

1. Créer un projet Railway et le connecter à ce dépôt GitHub — le Dockerfile est détecté
   automatiquement.
2. **Ajouter un volume** monté sur `/data` (Service → Settings → Volumes) : c'est là que vivent la
   base SQLite et les justificatifs. Sans volume, les données sont perdues à chaque déploiement.
   ⚠️ Les volumes Railway sont montés `root` alors que l'image tourne en `node` : définir la
   variable de service `RAILWAY_RUN_UID=0`
   ([doc Railway](https://docs.railway.com/volumes/reference#caveats)), sinon SQLite ne pourra pas
   écrire dans `/data`.
3. Générer un domaine public (Settings → Networking). Railway injecte `PORT` automatiquement.

Le service est connecté au dépôt GitHub (`BadRom1/ShareMate`, branche `main`) : chaque push sur
`main` déclenche automatiquement un déploiement. Un déploiement manuel ponctuel reste possible avec
`railway up` depuis la racine.

## CI

GitHub Actions :

- **`ci.yml`** : lint → format → typecheck → tests avec couverture (seuils bloquants) → audit npm →
  build, plus un job de build de l'image Docker — à chaque push sur `main` et pull request.
- **`codeql.yml`** : analyse statique de sécurité (push, PR, et chaque lundi).
- **Dependabot** (`.github/dependabot.yml`) : mises à jour hebdomadaires groupées des dépendances
  npm, des actions GitHub et de l'image Docker de base.

## Feuille de route

1. ~~**PWA** : manifest + service worker (Vite PWA), installable sur mobile.~~ ✅ Fait —
   `vite-plugin-pwa` (autoUpdate), manifest + icônes générées depuis `web/public/logo.svg`
   (`npm run generate-pwa-assets`), shell préchargé (offline), API en `NetworkFirst`.
2. ~~**Android** : encapsulation Capacitor du front existant.~~ ✅ Fait — voir
   [Application mobile](#application-mobile-android). **iOS** reste à ajouter (`cap add ios`,
   buildable via un Mac ou un build cloud type Codemagic).
3. Authentification légère (magic link), notifications de rappel d'entretien, multi-groupes.

## Application mobile (Android)

Le front web est empaqueté tel quel dans une app native via [Capacitor](https://capacitorjs.com)
(projet dans `web/android`, `appId` `app.sharemate.mobile`). L'hexagone est intact : le serveur et
l'API ne changent pas, l'app native tape simplement le backend distant.

**Deux adaptations** rendent le web compatible du natif :

- **Base d'API configurable** : en web les appels sont relatifs (`/api/...`, même-origine) ; en
  natif ils visent `VITE_API_BASE_URL` (l'URL Railway), injectée au build.
- **Auth par token** : les cookies cross-origin ne sont pas fiables en WebView. Le serveur accepte
  donc le token de session aussi via `Authorization: Bearer` (le web reste sur cookie httpOnly), et
  l'app le stocke dans le stockage natif (`@capacitor/preferences`). Activé par l'en-tête
  `X-ShareMate-Client: native` que seul le client natif envoie.

### Variables

| Variable                 | Où          | Rôle                                                                       |
| ------------------------ | ----------- | -------------------------------------------------------------------------- |
| `VITE_API_BASE_URL`      | build web   | URL du backend pour l'app native (ex. `https://sharemate.up.railway.app`). |
| `CORS_ORIGINS` (serveur) | env Railway | Origines autorisées, séparées par des virgules (ex. `https://localhost`).  |

Côté Railway, ajouter la variable de service :

```
CORS_ORIGINS=https://localhost
```

(`https://localhost` est l'origine de la WebView Android ; ajouter `capacitor://localhost` le jour
où iOS est ajouté.)

### Construire l'APK / AAB

**En CI (recommandé, aucun outil local)** : le workflow
[`.github/workflows/android.yml`](.github/workflows/android.yml) build l'APK debug (et l'AAB release
signé si un keystore est configuré) sur un runner Linux. Guide complet — clé de signature, secrets
GitHub, publication Play Store — dans [docs/deploiement-android.md](docs/deploiement-android.md).

**En local (alternative)** avec **Android Studio** (SDK + JDK), depuis `web/` :

```bash
VITE_API_BASE_URL=https://<ton-domaine-railway> npm run build --workspace web
npm run cap --workspace web -- sync android
npm run cap --workspace web -- open android   # puis Run / Build APK depuis l'IDE
```

Les icônes et le splash sont générés depuis `web/assets/` (sources vectorielles rasterisées) via
`capacitor-assets generate --android`.
