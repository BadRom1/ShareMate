# Runbook d'exploitation

Les gestes d'exploitation d'une instance en service : désigner l'administrateur, consulter la
base, transférer les justificatifs, sauvegarder et restaurer.

Tout part du même endroit : **la base SQLite et les fichiers vivent sur le volume Railway monté
sur `/data`**. Aucun de ces gestes ne se joue depuis votre machine — c'est là que sont les
données, et c'est là qu'il faut être.

> **Une règle avant toutes les autres.** Aucune sauvegarde n'est prise par défaut. Avant une
> migration de schéma, une suppression manuelle ou une restauration, faites une copie — la
> procédure est en fin de page.

## Ouvrir un shell sur l'instance

```bash
npm i -g @railway/cli
railway link           # une fois, pour rattacher le dossier au projet
railway ssh            # shell dans le conteneur en cours d'exécution
```

⚠️ **`railway run` n'est pas `railway ssh`.** `railway run <commande>` exécute la commande **sur
votre machine**, avec seulement les variables du service injectées : le volume n'y est pas. Un
script lancé ainsi ne verrait pas `/data`, retomberait sur un chemin local et **créerait une base
vide** — pour vous annoncer sereinement que l'instance ne contient aucun membre. Rien n'est cassé,
mais la réponse est fausse, et c'est pire. Pour tout ce qui suit : `ssh`.

## Ce que contient l'image de production

Le `Dockerfile` construit une image minimale. Quatre absences expliquent toutes les commandes de
cette page :

| Absent de l'image     | Pourquoi                                 | Conséquence                          |
| --------------------- | ---------------------------------------- | ------------------------------------ |
| `server/src/`         | Seul `server/dist` est copié             | Les scripts s'appellent par `dist`   |
| `tsx`                 | Dépendance de développement, `npm prune` | `npm run <script>` échoue            |
| `package.json` racine | Non copié                                | `npm run` depuis `/app` échoue aussi |
| Client `sqlite3`      | `node:24-slim` ne l'embarque pas         | La base se lit par `better-sqlite3`  |

Chaque script a donc **deux formes** — celle du dépôt, et celle du conteneur :

| Geste                        | Dans le dépôt              | Dans le conteneur                      |
| ---------------------------- | -------------------------- | -------------------------------------- |
| Désigner l'administrateur    | `npm run admin:designate`  | `node server/dist/designate-admin.js`  |
| Transférer les justificatifs | `npm run migrate:receipts` | `node server/dist/migrate-receipts.js` |

Les arguments se passent sans `--` dans le conteneur : `--` ne sert qu'à les faire traverser
`npm run`. Lancés sans argument, les deux scripts **n'écrivent rien** — ils disent ce qu'ils
feraient.

## Désigner l'administrateur

L'administrateur est le seul compte autorisé à réunir deux membres en un. Sur une base créée
avant ce rôle, **personne ne l'est** : la migration n'attribue rien, faute de repère fiable
(`invited_by` vaut `NULL` sur tous les membres d'alors). Se tromper donnerait à quelqu'un le
pouvoir d'absorber n'importe quel compte, alors le script ne devine pas — il montre.

```bash
node server/dist/designate-admin.js        # liste les comptes, n'écrit rien
```

```
3 compte(s), dans l'ordre où ils ont été créés :

  1. Alice <alice@exemple.fr>
     8f2c…  [ADMINISTRATEUR]
  2. Damien
     4b7e…
  3. Damien <damien@exemple.fr>
     a913…  [jamais ouvert]

Administrateur actuel : Alice (8f2c…).
```

**C'est aussi la seule façon de savoir qui est administrateur sans l'être soi-même** : l'écran
d'administration n'est visible que par son titulaire.

L'ordre est celui des insertions (`rowid`) : sur une base qui n'a jamais vu de reprise à la main,
le premier compte ouvert est le premier de la liste. Sans administrateur, le script signale le
candidat le plus probable — le premier compte inséré qui porte un mot de passe — et s'arrête là.
Le choix reste à l'opérateur.

```bash
node server/dist/designate-admin.js <identifiant>   # désigne ce compte
```

Le rôle est **unique** : le désigner le retire à tout autre. Un compte jamais ouvert est refusé —
il ne pourrait pas se connecter pour l'exercer. Le changement est immédiat, sans redémarrage ni
reconnexion : il est lu à chaque requête.

## Consulter la base

Le client `sqlite3` n'est pas dans l'image, mais `better-sqlite3` y est, en dépendance de
production :

```bash
node -e "console.log(require('better-sqlite3')('/data/sharemate.sqlite').prepare('SELECT id,name,is_admin FROM members ORDER BY rowid').all())"
```

Pour une session interactive, `node` puis `const db = require('better-sqlite3')('/data/sharemate.sqlite')`.
**Ouvrez en lecture seule** (`{ readonly: true }`) tant que vous ne comptez pas écrire : c'est ce
qui empêche une erreur de frappe de devenir un incident.

Quelques questions courantes :

```sql
SELECT id, name, email, is_admin FROM members ORDER BY rowid;   -- qui existe, qui administre
PRAGMA user_version;                                            -- version de schéma appliquée
SELECT COUNT(*) FROM sessions WHERE expires_at > datetime('now'); -- sessions actives
```

## Transférer les justificatifs vers le bucket

À ne lancer **qu'après** avoir posé les variables `S3_*`. La bascule ne demande aucune coupure :
les nouveaux fichiers partent déjà dans le bucket, et ceux restés sur le volume continuent d'y
être lus. Ce script ne fait que vider le volume de ce qui n'a plus à y être — **le volume, lui,
reste indispensable : il porte la base.**

```bash
node server/dist/migrate-receipts.js --dry   # dit ce qu'il ferait, sans rien écrire
node server/dist/migrate-receipts.js         # transfère
```

Il copie, ne supprime rien, et se rejoue sans dommage. Il signale à part les fichiers qu'aucune
dépense ne nomme et ceux dont le nom n'est pas celui qu'un téléversement produit : ni les uns ni
les autres ne sont transférés.

**Supprimer les fichiers locaux reste un geste manuel**, après avoir rouvert quelques
justificatifs depuis l'application : jusque-là, le volume en détient la seule autre copie.

## Sauvegarder le volume

`cp` sur une base SQLite ouverte peut produire une copie incohérente : en mode WAL, les écritures
récentes vivent dans un fichier séparé que la copie ne reprend pas. Il faut passer par l'API de
sauvegarde, qui produit un fichier autonome même pendant que le service écrit.

Faute de client `sqlite3` dans l'image, c'est `better-sqlite3` qui la porte :

```bash
node -e "require('better-sqlite3')('/data/sharemate.sqlite').backup('/data/sauvegarde-'+new Date().toISOString().slice(0,10)+'.sqlite').then(r=>console.log(r.totalPages,'pages copiées'))"
```

Relisez la copie **avant de vous y fier** — une sauvegarde jamais relue n'est pas une sauvegarde :

```bash
node -e "const d=require('better-sqlite3')('/data/sauvegarde-2026-08-24.sqlite',{readonly:true});console.log(d.pragma('integrity_check',{simple:true}),d.pragma('user_version',{simple:true}))"
```

`ok` et un numéro de version : la copie est saine. Rapatriez-la ensuite hors du volume — une
sauvegarde qui dort à côté de l'original ne protège que des fausses manœuvres, pas de la perte du
volume.

Les justificatifs (`/data/uploads`) sont à sauvegarder séparément : la base n'en porte que les
chemins.

## Restaurer

1. Arrêter le service (Railway → Settings → _Remove/Stop deployment_), pour qu'aucune écriture ne
   se perde entre la copie et le remplacement.
2. Remettre le fichier sous le nom attendu par `DATABASE_PATH` (`/data/sharemate.sqlite` par
   défaut), et **supprimer les `-wal` et `-shm` qui traînent** : ils appartiennent à la base
   remplacée et la contrediraient.
3. Redémarrer. Les migrations manquantes sont rejouées à l'ouverture, une transaction par étape.

Un schéma reconnu comme incompatible **fait échouer le démarrage** au lieu de supprimer des
tables : le message nomme la table en cause, et c'est à l'opérateur de trancher.

## Vérifier qu'une instance est en vie

```bash
curl -fsS https://<domaine>/api/health     # {"status":"ok"}
```

C'est l'URL du healthcheck Railway (`railway.json`) : elle n'exige aucune session et ne touche pas
la base — elle dit que le serveur répond, pas que la base est saine. Pour cela, `PRAGMA
integrity_check` ci-dessus.
