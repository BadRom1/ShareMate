# 🚜 ShareMate

Application de gestion collective de matériel partagé pour un petit groupe (2 à 5 voisins/amis) :
minipelle, véhicule utilitaire, bétonnière… Réservations, suivi d'usage, alertes d'entretien et
partage des frais façon Tricount.

## Fonctionnalités (MVP)

- **Comptes et cercles** : chaque membre a un compte (mot de passe, session). Le premier compte
  s'ouvre au premier démarrage ; les suivants entrent par un **lien de première connexion** que
  n'importe quel membre peut émettre et transmettre hors application. Il n'y a pas de « groupe »
  au sens d'une entité : le cercle d'un équipement est **la liste de ses membres**, et un membre
  peut appartenir à plusieurs cercles sans qu'ils se voient entre eux.
- **Équipements** : CRUD complet (nom, catégorie, date d'acquisition, valeur d'achat, membres du
  cercle, type de compteur heures/km). Un équipement appartient à son cercle, pas à un propriétaire
  unique. Tout changement de composition notifie les entrants, les sortants et ceux qui restent ;
  se retirer soi-même est un geste dédié (« quitter le cercle »).
- **Réservations** : calendrier de créneaux par équipement, détection de conflit (409 en cas de
  chevauchement), vue calendrier commune à tous les cercles du membre, récurrences plafonnées à
  52 occurrences.
- **Suivi d'usage** : à chaque fin d'utilisation, saisie du relevé de compteur, carburant ajouté et
  remarques ; historique par équipement et par membre ; **alertes d'entretien** dès qu'un seuil
  d'heures/km est dépassé depuis la dernière maintenance déclarée.
- **Frais partagés** : dépenses (achat, assurance, carburant, entretien, réparation) avec justificatif
  image/PDF optionnel ; répartition **par parts égales**, **au prorata du temps d'usage** (calculé à
  partir des réservations) ou **montants personnalisés** ; soldes « qui doit combien à qui » avec
  **minimisation du nombre de transactions** ; historique des remboursements déclarés.
- **Checklists** : une ou plusieurs checklists par équipement (ex. « Avant utilisation »,
  « Hivernage ») avec leurs points de contrôle. Une checklist **appartient au cercle, pas à son
  créateur** : tout membre du cercle peut la cocher, la renommer, ajouter/modifier/supprimer ses
  points et la supprimer entièrement. Chaque coche garde la trace de qui l'a validée et quand, et le
  créateur reste affiché. Avancement affiché (`3/7`) et remise à zéro en un geste pour réutiliser la
  checklist à la prochaine sortie.
- **Documents** : un dossier par équipement, où le cercle range ce qui s'y rattache — manuel
  d'utilisation, certificat d'assurance, facture d'achat, photos — sous forme de **fichiers
  déposés** ou de **liens externes**, dans une même liste. Chaque document porte une catégorie
  choisie à la main (Manuel, Assurance, Achat & garantie, Entretien, Photos, Autre) et se
  renomme. Comme une checklist, un document **appartient au cercle et non à son déposant** : tout
  membre peut le renommer, le reclasser et le supprimer, et le nom du déposant reste affiché. Les
  fichiers vivent dans un **stockage d'objets S3/R2** (repli sur le disque si aucun bucket n'est
  configuré) ; la base n'en garde que les métadonnées.
- **Discussions** : fils de discussion par équipement, avec sous-fils de réponses. Le fil et le
  message se renomment, s'éditent et se suppriment **par leur auteur seul** ; tout le cercle lit et
  répond.
- **Notifications** : centre in-app (cloche), Web Push (PWA) et push natif Android, réglables par
  type d'événement et par membre. Détail et configuration dans [docs/notifications.md](docs/notifications.md).

## Architecture

DDD + architecture hexagonale, TypeScript de bout en bout, développé en TDD strict.

```
server/src/
├── domain/           # Entités, value objects, règles métier pures — AUCUNE dépendance externe
│   ├── shared/       # Money (centimes entiers), TimeRange (fin exclusive), erreurs métier
│   ├── member/       # Member (email validé : il sert d'identifiant de connexion)
│   ├── auth/         # MemberCredential (mot de passe, invitation datée), Session
│   ├── equipment/    # Equipment (cercle des membres, compteur heures/km, seuil d'entretien)
│   ├── reservation/  # Reservation + règle de non-chevauchement, récurrences
│   ├── usage/        # UsageRecord + calcul des alertes de maintenance
│   ├── expense/      # Expense (règles de répartition), Reimbursement,
│   │                 # calcul des soldes + minimisation des transactions (type Tricount)
│   ├── discussion/   # Thread + Message (sous-fils de réponses)
│   ├── checklist/    # Checklist + ChecklistItem (points cochés, traçabilité de la coche)
│   ├── document/     # Document (fichier déposé ou lien externe, catégorie, borne de poids)
│   └── notification/ # Notification, NotificationPreference, types notifiables
├── application/      # Use cases + ports (repositories, Clock, IdGenerator, Notifier, AuditLogger)
│                     # equipment-access.ts : règle d'accès unique (cercle de l'équipement)
│                     # receipt-access.ts   : un justificatif suit la dépense qui le porte
│                     # document-access.ts  : purge des objets qu'aucun document ne nomme plus
└── infrastructure/   # Adapters
    ├── http/         # Fastify : app.ts (transverse) + plugins/ (un fichier par domaine)
    ├── persistence/  # SQLite (better-sqlite3), migrations versionnées par PRAGMA user_version
    └── tech/         # scrypt, UUID, horloge, push (Web Push + FCM)
                      # object-store.ts : magasin d'objets brut (disque ou bucket S3/R2),
                      # partagé par les justificatifs et les documents
web/src/              # Front React (Vite) — adapter de présentation
```

Les frontières sont vérifiées par ESLint : le domaine ne peut rien importer des couches
application/infrastructure, l'application ne peut pas importer l'infrastructure.

**Choix notables**

- Les montants sont des **centimes entiers** (`Money`) ; les répartitions utilisent la méthode des
  plus forts restes — pas un centime perdu.
- Les créneaux sont des intervalles **à fin exclusive** : deux réservations adjacentes ne se
  chevauchent pas.
- Le relevé de compteur est **monotone** : un relevé inférieur au dernier connu est refusé.
- Le **cercle est porté par l'équipement**, pas par une entité « groupe ». Deux personnes sans
  équipement commun ne se voient pas, ce qui donne le multi-cercles sans multi-tenant.
- Un document est **une entité, deux natures** (`FILE` ou `LINK`) : le membre range un manuel PDF
  et un tutoriel vidéo côte à côte, et le code n'a qu'une liste, qu'une règle d'accès, qu'une
  suppression. La table l'écrit aussi, par une contrainte `CHECK` qui exclut la rangée hybride.
- Le stockage d'objets est **le même code pour R2 et S3** : R2 parle le protocole S3, seul
  l'`endpoint` change. Un port `ObjectStorage` côté application, un magasin brut côté
  infrastructure — que justificatifs et documents partagent —, et un repli disque quand les
  variables du bucket sont absentes : les tests et le développement tournent sans bucket, comme le
  push tourne sans clés VAPID.
- Un chemin de justificatif (`/uploads/<uuid>.<ext>`) est **un identifiant, pas une adresse** : il
  n'a pas changé au passage dans le bucket, où il devient la clé `receipts/<uuid>.<ext>`. C'est ce
  qui permet de basculer sans réécrire une seule dépense, ni le schéma HTTP, ni le front.
- Toutes les entrées HTTP sont validées par un **schéma JSON** (Ajv, embarqué dans Fastify) :
  objets fermés, bornes de longueur, énumérations tirées du domaine. Les types TypeScript des
  handlers décrivent donc ce qui arrive réellement.

## Développement

```bash
npm install
npm test              # 546 tests : 456 serveur (Node) + 90 front (jsdom)
npm run test:coverage # Tests + seuils de couverture (90 % lignes/fonctions, 85 % branches)
npm run lint          # ESLint (frontières hexagonales + règles React hooks)
npm run format        # Prettier (format:check en CI)
npm run typecheck     # tsc sur les deux workspaces
npm run audit:prod    # npm audit des dépendances de production (high+)
npm run migrate:receipts -- --dry  # transfert des justificatifs du volume vers le bucket
npm run dev:server    # API sur http://localhost:3000
npm run dev:web       # Front Vite sur http://localhost:5173 (proxy /api → 3000)
npm run build         # Build de production (server/dist + web/dist)
npm start             # Sert l'API + le front buildé
```

### Conventions de code

- **Le français est la langue de ce qui se lit** : commentaires, messages d'erreur, libellés
  d'interface, noms de tests et messages de commit. **L'anglais est la langue de ce qui s'exécute** :
  identifiants du code de production (variables, fonctions, types, clés de journal d'audit), au même
  titre que les mots-clés du langage et les noms des bibliothèques. Les fichiers de test s'autorisent
  des identifiants français, qui prolongent l'intention décrite par le titre du test.
- **Un commentaire dit pourquoi**, jamais quoi : la contrainte, l'invariant, le piège que le code
  suivant évite. Ce que fait le code se lit dans le code.
- **Architecture hexagonale**, vérifiée par ESLint : `server/src/domain` ne dépend de rien,
  `server/src/application` ne dépend pas de `infrastructure`.

Variables d'environnement du serveur :

| Variable         | Défaut                       | Rôle                                                        |
| ---------------- | ---------------------------- | ----------------------------------------------------------- |
| `PORT`           | `3000`                       | Port HTTP                                                   |
| `DATA_DIR`       | `./data`                     | Répertoire des données persistantes                         |
| `DATABASE_PATH`  | `$DATA_DIR/sharemate.sqlite` | Fichier SQLite                                              |
| `UPLOADS_DIR`    | `$DATA_DIR/uploads`          | Justificatifs, quand aucun bucket S3/R2 n'est configuré     |
| `DOCUMENTS_DIR`  | `$DATA_DIR/documents`        | Documents, quand aucun bucket S3/R2 n'est configuré         |
| `S3_*`           | — (repli sur le disque)      | Bucket des justificatifs et des documents : voir ci-dessous |
| `WEB_DIST_DIR`   | `../web/dist`                | Front statique servi par le serveur                         |
| `NODE_ENV`       | —                            | `production` : cookie `Secure`, `trustProxy`, logs JSON     |
| `CORS_ORIGINS`   | — (vide : pas de CORS)       | Origines cross-origin autorisées, séparées par des virgules |
| `VAPID_*`, `FCM` | — (push désactivé)           | Push : voir [docs/notifications.md](docs/notifications.md)  |

### Stockage des fichiers (Cloudflare R2 ou Amazon S3)

**Justificatifs de dépense et documents d'équipement** partagent le même bucket compatible S3, sous
deux préfixes distincts (`receipts/`, `documents/`), dès que ces quatre variables sont présentes.
Sinon ils tombent respectivement sur `UPLOADS_DIR` et `DOCUMENTS_DIR`, ce qui permet de développer
et de tester sans bucket.

| Variable               | Rôle                                                         |
| ---------------------- | ------------------------------------------------------------ |
| `S3_BUCKET`            | Nom du bucket                                                |
| `S3_ENDPOINT`          | `https://<id-de-compte>.r2.cloudflarestorage.com` pour R2    |
| `S3_ACCESS_KEY_ID`     | Identifiant du jeton d'accès                                 |
| `S3_SECRET_ACCESS_KEY` | Secret du jeton d'accès                                      |
| `S3_REGION`            | `auto` par défaut (valeur documentée par Cloudflare pour R2) |

**Le bucket doit rester privé.** L'application ne s'appuie jamais sur un accès public : elle émet
une URL signée valable cinq minutes, après avoir vérifié que le demandeur appartient au cercle de
l'équipement. Un bucket ouvert rendrait ce contrôle décoratif.

Plafonds et formats diffèrent selon la nature du fichier :

|                  | Justificatif de dépense | Document d'équipement                            |
| ---------------- | ----------------------- | ------------------------------------------------ |
| Poids maximal    | 10 Mo                   | 25 Mo par fichier, 500 Mo par équipement         |
| Formats acceptés | png, jpg, webp, pdf     | + gif, txt, csv, doc(x), xls(x), ppt(x), od[tsp] |

Ni exécutables, ni archives, ni HTML, ni SVG : le contenu est servi depuis le domaine du bucket,
distinct du nôtre, où une page fabriquée s'exécuterait dans son propre contexte.

#### Faire passer les justificatifs existants dans le bucket

La bascule **ne casse rien et ne demande aucune coupure** : dès que les variables sont posées, les
nouveaux fichiers vont dans le bucket, et ceux restés sur le volume continuent d'être lus de là. Le
chemin public d'un justificatif (`/uploads/<uuid>.<ext>`) ne change pas — c'est son identifiant,
pas l'endroit où il dort — donc aucune dépense n'est à réécrire.

Reste à vider le volume, quand on veut le démonter :

```bash
# Depuis un shell sur le service, variables S3_* et DATA_DIR en place :
npm run migrate:receipts -- --dry   # dit ce qu'il ferait, sans rien écrire
npm run migrate:receipts            # transfère
```

Le script copie, ne supprime rien, et se rejoue sans dommage : ce qui est déjà dans le bucket est
laissé tel quel. Il signale à part les fichiers qu'aucune dépense ne nomme (orphelins d'anciennes
suppressions) et ceux dont le nom n'est pas celui qu'un téléversement produit — ni les uns ni les
autres ne sont transférés.

**Supprimer les fichiers locaux reste un geste manuel**, après avoir rouvert quelques justificatifs
depuis l'application : jusque-là, le volume en détient la seule autre copie.

## Sécurité

### Modèle de menace retenu

L'instance est **une communauté de connaissances**, pas un service ouvert. Elle protège un membre
contre les autres membres de l'instance avec lesquels il ne partage rien, et contre un tiers non
authentifié. Elle **ne** le protège **pas** contre les membres de ses propres cercles : entre eux,
la confiance est totale et assumée. Le reste de cette section dit précisément où passe cette ligne.

**Qui peut entrer**

- Le tout premier compte s'ouvre sans authentification, une seule fois, tant qu'aucun compte
  n'existe (`POST /api/auth/bootstrap`, insertion atomique : deux requêtes simultanées ne créent
  pas deux « premiers comptes »).
- Ensuite, **tout membre authentifié peut créer un compte** et obtenir son lien de première
  connexion, qu'il transmet hors application. C'est le choix du produit : pas d'administrateur, la
  communauté se coopte. Le garde-fou est un plafond de 20 créations par minute et par IP, pas un
  droit.
- Un lien de première connexion **expire au bout de 7 jours**, ne sert qu'une fois, et **ne vaut
  que pour un compte qui n'a jamais eu de mot de passe**. Régénérer un lien n'est possible que
  pour soi-même, pour un membre d'un cercle partagé, ou pour quelqu'un qu'on a soi-même invité ;
  hors de là, la réponse est celle d'un membre inexistant, et toute régénération visant un autre
  que soi est tracée en `warn`.
- **Conséquence assumée** : un mot de passe perdu ne se réinitialise pas. Rendre cela possible sans
  preuve hors bande (email vérifié) rouvrirait exactement la prise de contrôle de compte que cette
  règle ferme. Le compte est alors à recréer.

**Qui voit qui**

- L'annuaire (`GET /api/members`) est cadré sur le périmètre du demandeur : lui-même, les membres
  des cercles qu'il partage, et ceux qu'il a invités tant qu'aucun équipement ne les réunit encore.
  Hors de ce périmètre, un membre n'apprend ni l'existence, ni le nom, ni l'email des autres.
- Tout ce qui pend à un équipement (réservations, usage, dépenses, soldes, justificatifs,
  discussions, checklists, documents) n'est lisible et modifiable que par les membres de son cercle. La règle
  est unique et vit dans la couche application (`equipment-access.ts`, `receipt-access.ts`) ; les
  tests d'intégration la vérifient route par route. Les vues transverses (liste des équipements,
  calendrier, alertes d'entretien, historique d'un membre) sont cadrées sur le périmètre du
  demandeur, et le cadrage descend jusqu'aux requêtes SQL.
- Une notification est **personnelle** : seul son destinataire la lit et la marque lue. Celle d'un
  autre membre répond comme un identifiant inconnu.
- **Anti-énumération** : hors du cercle, la ressource n'est pas refusée, elle est **masquée** —
  même code (`404`) et même message que si elle n'existait pas, y compris sur un justificatif dont
  on détiendrait le chemin. Une réponse ne permet donc pas de distinguer « cet identifiant n'existe
  pas » de « il existe mais pas pour vous ». La trace serveur (`warn`) conserve la vérité pour
  l'exploitant. Un geste réservé à l'auteur d'un fil, lui, répond `403` : la ressource est bien
  visible du cercle, seul le geste est refusé.
- La connexion ne dit rien non plus : identifiant inconnu, invitation jamais consommée et mot de
  passe faux donnent le même message **et le même temps de réponse** (une dérivation scrypt leurre
  est faite quand il n'y a rien à vérifier).

**Ce qui est protégé**

- **Mots de passe** : scrypt N = 2¹⁷ (recommandation OWASP), paramètres écrits dans le hachage,
  comparaison à temps constant. Durcir le coût plus tard n'invalide rien : chaque membre est
  re-haché silencieusement à sa connexion suivante.
- **Sessions** : jetons de 32 octets aléatoires stockés **hachés** (SHA-256), cookie `httpOnly` +
  `SameSite=Lax` (+ `Secure` en production), 30 jours en expiration glissante. Un changement de
  mot de passe ou la consommation d'une invitation **révoque toutes les sessions** du membre, et en
  rouvre une seule pour l'auteur du geste.
- **Entrées** : schéma JSON sur le corps, les paramètres et la querystring de chaque route ; objets
  fermés, longueurs bornées. Un chemin de justificatif n'est accepté que sous la forme exacte que
  produit le téléversement, ce qui interdit d'afficher une URL externe sous couvert de reçu.
- **Justificatifs** : servis par une route applicative qui remonte à la dépense qui les porte,
  jamais mis en cache par le client (`Cache-Control: private, no-store`, `NetworkOnly` côté service
  worker), supprimés avec la dépense — du bucket **et** du volume, puisqu'après une bascule on ne
  sait plus lequel des deux les porte. La déconnexion vide les caches `sharemate-*` de l'appareil.
- **Bucket** : il n'est jamais public, ni pour les justificatifs ni pour les documents. Un contenu
  se demande toujours par l'identifiant de la ressource applicative qui le porte — la dépense pour
  un justificatif, le document pour un fichier du dossier — jamais par la clé de l'objet, qui ne
  sort pas du serveur. L'API vérifie le cercle, puis redirige vers une **URL signée de cinq
  minutes**, jamais mise en cache (`Cache-Control: private, no-store`). Recopiée, elle expire ; un
  lien de bucket ouvert, lui, n'expire jamais. Le type MIME servi est déduit de l'extension
  acceptée et jamais celui annoncé par le client, et ni HTML, ni SVG, ni archive, ni exécutable
  n'entrent — servi depuis le domaine du bucket, un tel contenu s'y exécuterait.
- **Liens du dossier** : seuls `http:` et `https:` sont acceptés. Un lien est cliquable par tout
  le cercle : `javascript:` y exécuterait du code dans la session de celui qui clique, et `data:`
  y afficherait une page fabriquée sous l'apparence de l'application.
- **Rate-limit** par IP et par minute : 300 en global sur toute route, 10 sur les routes
  d'authentification publiques (force brute), 20 sur la création de compte et le téléversement.
  `trustProxy` est activé en production pour lire la vraie IP derrière le proxy Railway.
- **En-têtes** : `@fastify/helmet` — CSP `default-src 'self'`, `frame-ancestors 'none'`,
  `object-src 'none'`, `nosniff`, HSTS.
- **Logs** : pino JSON en production ; `cookie`, `set-cookie` et `authorization` expurgés (le jeton
  de l'app native transite en `Bearer`). Les changements de composition d'un cercle partent dans le
  journal du serveur, hors de portée des membres concernés.
- **Conteneur** : image non-root (`USER node`), `HEALTHCHECK` intégré.
- **Chaîne d'appro** : audit npm en CI (bloquant à partir de high), CodeQL hebdomadaire,
  Dependabot (npm, GitHub Actions, image Docker de base).

**Ce qui n'est pas protégé — et pourquoi**

- **Aucun rôle, aucun administrateur.** Tous les membres d'un cercle ont exactement les mêmes
  pouvoirs : modifier l'équipement, en changer la composition, le supprimer avec tout son
  historique de dépenses et de soldes. Un membre peut en évincer un autre. Ce n'est pas empêché,
  c'est **rendu visible** : tout changement de composition notifie les entrants, les sortants et
  les témoins, et laisse une entrée dans le journal du serveur.
- **Tout membre peut peupler l'instance** de nouveaux comptes. Cela ne lui ouvre aucun cercle
  existant, mais rien n'en borne le nombre au-delà du plafond par minute.
- **Pas de chiffrement au repos.** La base SQLite est en clair sur le volume, les justificatifs et
  les documents le sont dans le bucket (ou sur le volume, à défaut) ; qui y a accès — ou à une
  sauvegarde — a accès à tout. Le contrôle d'accès est applicatif, pas cryptographique.
- **Un document appartient au cercle, pas à son déposant.** N'importe quel membre peut supprimer
  le manuel ou l'attestation d'assurance qu'un autre a déposés, définitivement. C'est le même
  parti que pour les checklists et les équipements : entre membres d'un cercle, la confiance est
  totale et assumée. Ce qui est fait, en revanche, est visible — le nom du déposant reste affiché.
- **Pas de vérification d'email.** L'adresse sert d'identifiant de connexion, elle n'est jamais
  confirmée — d'où l'absence de réinitialisation de mot de passe.
- **`trustProxy` fait confiance à toute la chaîne `X-Forwarded-For`.** Si le service devient
  joignable autrement que par le proxy Railway, un client peut forger l'en-tête et contourner le
  plafond par IP. Tant que l'accès passe exclusivement par le proxy, le risque est nul.
- **Pas de quota de stockage par membre** : 10 Mo par justificatif et 20 téléversements par minute,
  mais rien ne borne le total. Les documents, eux, sont bornés par équipement (500 Mo) — un membre
  peut néanmoins remplir ce quota et empêcher les autres de déposer quoi que ce soit.

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

### Migrations de schéma

Le schéma est versionné par `PRAGMA user_version`, en face d'une liste ordonnée de migrations
(`server/src/infrastructure/persistence/sqlite/database.ts`). Au démarrage, seules les étapes
manquantes sont appliquées, chacune dans sa propre transaction : la version n'avance que si l'étape
a réussi entièrement, et une base déjà à jour ne rejoue rien.

Pour faire évoluer le schéma, **ajouter une étape à la fin de `MIGRATIONS`** — jamais modifier une
étape existante, son rang est sa version. Chaque `apply` doit rester idempotent : les bases
antérieures au versionnement valent `0` et rejouent la liste entière.

Un schéma reconnu comme incompatible (tables du modèle « collectif » abandonné, mur de messages
plat antérieur aux fils) **fait échouer le démarrage** au lieu de supprimer les tables comme le
faisaient les versions antérieures. Le message nomme la table en cause : c'est à l'opérateur de
trancher, sauvegarde en main.

### Sauvegarder le volume

La base et les justificatifs vivent sur le volume Railway, qu'aucune sauvegarde ne couvre par
défaut. **Avant toute migration de schéma, toute suppression manuelle de table et toute
restauration**, prendre une copie.

`sqlite3 .backup` est la seule façon correcte de copier une base SQLite ouverte : `cp` d'un fichier
en mode WAL peut produire une copie incohérente (le WAL n'est pas repris).

```bash
# Depuis un shell sur le service, ou en local sur le fichier de DATABASE_PATH :
sqlite3 /data/sharemate.sqlite ".backup '/data/sauvegarde-$(date +%F).sqlite'"
```

Le fichier produit est cohérent et autonome : il se rapatrie ensuite par n'importe quel moyen.
Vérifier la copie avant de s'y fier — une sauvegarde jamais relue n'est pas une sauvegarde :

```bash
sqlite3 sauvegarde.sqlite "PRAGMA integrity_check; PRAGMA user_version;"
```

Restaurer, c'est arrêter le service, remettre le fichier en place sous le nom attendu par
`DATABASE_PATH`, et redémarrer : les migrations manquantes seront rejouées à l'ouverture. Les
justificatifs (`$DATA_DIR/uploads`) sont à sauvegarder séparément — la base n'en contient que les
chemins.

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
   (`npm run generate-pwa-assets`), shell préchargé (offline), API en `NetworkFirst`, justificatifs
   jamais mis en cache.
2. ~~**Android** : encapsulation Capacitor du front existant.~~ ✅ Fait — voir
   [Application mobile](#application-mobile-android). **iOS** reste à ajouter (`cap add ios`,
   buildable via un Mac ou un build cloud type Codemagic).
3. ~~**Authentification**~~ ✅ Faite, mais pas sous la forme prévue : ni magic link ni email, un
   lien de première connexion transmis hors application (voir [Sécurité](#sécurité)).
4. ~~**Notifications de rappel d'entretien**~~ ✅ Faites — `MAINTENANCE_ALERT`, in-app et push,
   parmi cinq autres types.
5. **Réinitialisation de mot de passe** : suppose une preuve hors bande, donc la vérification des
   adresses email. C'est aujourd'hui le seul geste qu'un membre ne peut pas faire seul.
6. **Multi-cercles assumé** : le modèle le permet déjà (un membre, plusieurs équipements, des
   cercles disjoints) ; ce qui manque est l'interface — rien ne montre à un membre qu'il vit dans
   plusieurs cercles étanches.

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
