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
npm test              # 122 tests (domaine, application, intégration SQLite + HTTP)
npm run lint          # ESLint (avec règles de frontières hexagonales)
npm run typecheck     # tsc sur les deux workspaces
npm run dev:server    # API sur http://localhost:3000
npm run dev:web       # Front Vite sur http://localhost:5173 (proxy /api → 3000)
npm run build         # Build de production (server/dist + web/dist)
npm start             # Sert l'API + le front buildé
```

Variables d'environnement du serveur :

| Variable        | Défaut               | Rôle                                   |
| --------------- | -------------------- | -------------------------------------- |
| `PORT`          | `3000`               | Port HTTP                              |
| `DATA_DIR`      | `./data`             | Répertoire des données persistantes    |
| `DATABASE_PATH` | `$DATA_DIR/sharemate.sqlite` | Fichier SQLite                 |
| `UPLOADS_DIR`   | `$DATA_DIR/uploads`  | Justificatifs uploadés                 |
| `WEB_DIST_DIR`  | `../web/dist`        | Front statique servi par le serveur    |

## Déploiement sur Railway

Le dépôt contient un `Dockerfile` multi-stage et un `railway.json` (healthcheck sur `/api/health`).

1. Créer un projet Railway et le connecter à ce dépôt GitHub — le Dockerfile est détecté
   automatiquement.
2. **Ajouter un volume** monté sur `/data` (Service → Settings → Volumes) : c'est là que vivent la
   base SQLite et les justificatifs. Sans volume, les données sont perdues à chaque déploiement.
3. Générer un domaine public (Settings → Networking). Railway injecte `PORT` automatiquement.

Chaque push sur la branche déployée déclenche un build + déploiement.

## CI

GitHub Actions (`.github/workflows/ci.yml`) : install → lint → typecheck → tests → build, à chaque
push et pull request.

## Feuille de route

1. **PWA** : manifest + service worker (Vite PWA), installable sur mobile — le front est déjà
   responsive et l'API stateless s'y prête.
2. **Android puis iOS** : encapsulation Capacitor du front existant ; le domaine et l'API restent
   inchangés (c'est l'intérêt de l'hexagone).
3. Authentification légère (magic link), notifications de rappel d'entretien, multi-groupes.
