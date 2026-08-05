import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './infrastructure/persistence/sqlite/database.js';
import { SqliteExpenseRepository } from './infrastructure/persistence/sqlite/repositories.js';
import { createS3ObjectStore } from './infrastructure/tech/object-store.js';
import { RECEIPT_PREFIX, receiptStorageKey } from './infrastructure/tech/receipt-storage.js';

/**
 * Transfert des justificatifs restés sur le volume vers le bucket S3/R2.
 *
 * L'application n'en a pas besoin pour fonctionner : tant que le volume est monté, elle relit de
 * là ce qui y dort (voir `createReceiptStorage`). Ce script sert à ne plus laisser de fichiers
 * dessus — le volume reste indispensable, il porte la base SQLite.
 *
 * Il est sans risque et rejouable : il copie, ne supprime rien, et repasse sur ce qui est déjà
 * dans le bucket sans le réécrire. Supprimer les fichiers locaux reste un geste de l'opérateur,
 * après vérification — un script qui efface la seule copie restante ne se rattrape pas.
 *
 *     npm run migrate:receipts            # transfère
 *     npm run migrate:receipts -- --dry   # dit ce qu'il ferait, sans rien écrire
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.resolve(here, '../../data');
const databasePath = process.env.DATABASE_PATH ?? path.join(dataDir, 'sharemate.sqlite');
const uploadsDir = process.env.UPLOADS_DIR ?? path.join(dataDir, 'uploads');
const dryRun = process.argv.includes('--dry');

const bucket = createS3ObjectStore(process.env);
if (!bucket) {
  console.error(
    'Aucun bucket configuré : renseignez S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID et ' +
      'S3_SECRET_ACCESS_KEY avant de lancer le transfert.',
  );
  process.exit(1);
}
/**
 * Contenu du répertoire, chaque entrée sachant déjà si elle est un fichier : `withFileTypes` le
 * tient de la lecture du répertoire elle-même.
 *
 * Ni `existsSync` avant la lecture, ni `statSync` avant chaque copie — demander au disque si
 * quelque chose est là, puis agir en supposant que la réponse tient encore, c'est poser une
 * question dont la réponse peut changer entre les deux appels. On lit, et l'absence est une
 * réponse comme une autre.
 */
function entréesDuRépertoire(): fs.Dirent[] {
  try {
    return fs.readdirSync(uploadsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    console.log(`Rien à transférer : ${uploadsDir} n’existe pas.`);
    process.exit(0);
  }
}

const db = openDatabase(databasePath);
const expenses = new SqliteExpenseRepository(db);

const résultats = { transférés: 0, déjàPrésents: 0, orphelins: [] as string[], illisibles: [] as string[] };

/** Justificatif nommé par au moins une dépense : les autres fichiers du répertoire sont orphelins. */
async function estRéférencé(receiptPath: string): Promise<boolean> {
  return (await expenses.findByReceiptPath(receiptPath)).length > 0;
}

for (const entrée of entréesDuRépertoire()) {
  if (!entrée.isFile()) continue;
  const nom = entrée.name;
  const receiptPath = `${RECEIPT_PREFIX}${nom}`;
  const fichier = path.join(uploadsDir, nom);

  // Un fichier dont le nom n'est pas celui qu'un téléversement produit n'a rien à faire dans le
  // bucket : le stockage refuserait de le relire, il ne serait de toute façon plus servi.
  const key = receiptStorageKey(receiptPath);
  if (!key) {
    résultats.illisibles.push(nom);
    continue;
  }
  if (!(await estRéférencé(receiptPath))) {
    résultats.orphelins.push(nom);
    continue;
  }
  if (await bucket.exists(key)) {
    résultats.déjàPrésents += 1;
    continue;
  }
  if (dryRun) {
    résultats.transférés += 1;
    continue;
  }
  const extension = path.extname(nom).toLowerCase();
  await bucket.put(key, await fs.promises.readFile(fichier), contentTypeDe(extension));
  résultats.transférés += 1;
}

/** Type MIME servi, déduit de l'extension — jamais lu dans le fichier lui-même. */
function contentTypeDe(extension: string): string {
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
  };
  return types[extension] ?? 'application/octet-stream';
}

db.close();

const verbe = dryRun ? 'à transférer' : 'transférés';
console.log(`${résultats.transférés} justificatif(s) ${verbe}, ${résultats.déjàPrésents} déjà dans le bucket.`);
if (résultats.orphelins.length > 0) {
  console.log(
    `${résultats.orphelins.length} fichier(s) qu’aucune dépense ne nomme, laissés sur place ` +
      `(supprimables) :\n  - ${résultats.orphelins.join('\n  - ')}`,
  );
}
if (résultats.illisibles.length > 0) {
  console.log(
    `${résultats.illisibles.length} fichier(s) hors du format attendu, laissés sur place ` +
      `:\n  - ${résultats.illisibles.join('\n  - ')}`,
  );
}
if (!dryRun && résultats.transférés > 0) {
  console.log(
    'Vérifiez quelques justificatifs depuis l’application avant de supprimer le contenu de ' +
      `${uploadsDir} : c’en est aujourd’hui la seule autre copie.`,
  );
}
