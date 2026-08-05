import { FileObjectStore, MediaStorage, createS3ObjectStore } from './object-store.js';
import type { MediaDelivery, MediaType, ObjectStore } from './object-store.js';
import type { ReceiptStorage as ReceiptStoragePort } from '../../application/ports.js';

/**
 * Préfixe public des justificatifs, seule forme qui circule hors de l'infrastructure — et la
 * seule que portent les dépenses en base.
 *
 * Il **reste** `/uploads/` après le passage au bucket : c'est l'identifiant du justificatif, pas
 * l'endroit où il dort. Le changer aurait imposé de réécrire toutes les dépenses existantes, le
 * schéma HTTP qui borne la forme d'un `receiptPath`, et le filtre du front qui décide ce qu'il
 * rend cliquable — pour ne rien apporter.
 */
export const RECEIPT_PREFIX = '/uploads/';

/** Préfixe des clés dans le magasin d'objets, distinct des documents qui partagent le bucket. */
export const RECEIPT_KEY_PREFIX = 'receipts/';

/** Extensions acceptées, et type MIME servi en retour — jamais celui annoncé par le client. */
const CONTENT_TYPES: Record<string, MediaType> = {
  '.png': { type: 'image/png', inline: true },
  '.jpg': { type: 'image/jpeg', inline: true },
  '.jpeg': { type: 'image/jpeg', inline: true },
  '.webp': { type: 'image/webp', inline: true },
  '.pdf': { type: 'application/pdf', inline: true },
};

/** Nom de fichier tel que produit par `save` : UUID v4 + extension acceptée. */
const RECEIPT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|webp|pdf)$/;

/**
 * Clé de stockage d'un chemin public, ou `null` si ce chemin n'a pas la forme exacte que `save`
 * produit. Seul endroit où la traduction se fait : une clé ne part donc jamais vers un magasin
 * sans être passée par ici, ce qui ferme la traversée de répertoire par construction.
 */
export function receiptStorageKey(receiptPath: string): string | null {
  const name = receiptPath.startsWith(RECEIPT_PREFIX) ? receiptPath.slice(RECEIPT_PREFIX.length) : '';
  return RECEIPT_NAME.test(name) ? `${RECEIPT_KEY_PREFIX}${name}` : null;
}

export type ReceiptDelivery = MediaDelivery;

/**
 * Justificatifs de dépense. Le chemin public et la clé de stockage sont deux formes du même
 * identifiant : `/uploads/<uuid>.<ext>` d'un côté, `receipts/<uuid>.<ext>` de l'autre.
 */
export class ReceiptStorage implements ReceiptStoragePort {
  private readonly media: MediaStorage;

  constructor(primary: ObjectStore, legacy?: ObjectStore) {
    this.media = new MediaStorage(primary, { keyPrefix: RECEIPT_KEY_PREFIX, contentTypes: CONTENT_TYPES }, legacy);
  }

  /** Extension (avec le point, en minuscules) acceptée au téléversement. */
  supports(extension: string): boolean {
    return this.media.supports(extension);
  }

  /** Écrit le justificatif sous un nom neuf et renvoie son chemin public. */
  async save(content: Buffer, extension: string): Promise<string> {
    const key = await this.media.save(content, extension);
    return `${RECEIPT_PREFIX}${key.slice(RECEIPT_KEY_PREFIX.length)}`;
  }

  /** Justificatif prêt à être servi, ou `null` si rien de tel n'est stocké. */
  async open(receiptPath: string): Promise<ReceiptDelivery | null> {
    const key = receiptStorageKey(receiptPath);
    if (!key) return null;
    // Le nom d'origine n'est pas conservé : le justificatif s'affiche, il ne se classe pas.
    return this.media.open(key, key.slice(RECEIPT_KEY_PREFIX.length));
  }

  async delete(receiptPath: string): Promise<void> {
    const key = receiptStorageKey(receiptPath);
    if (key) await this.media.delete(key);
  }
}

/**
 * Stockage des justificatifs choisi par l'environnement, exactement comme celui des documents :
 * bucket S3/R2 dès que ses quatre variables sont présentes, sinon le répertoire d'upload.
 *
 * Quand le bucket est configuré, le répertoire devient le **repli en lecture** : les justificatifs
 * déposés avant la bascule dorment encore sur le volume, et doivent rester lisibles sans qu'on ait
 * eu à les déplacer d'abord. `npm run migrate:receipts` les transfère ensuite, à froid.
 */
export function createReceiptStorage(env: NodeJS.ProcessEnv, uploadsDirectory: string | null): ReceiptStorage | null {
  const bucket = createS3ObjectStore(env);
  const disk = uploadsDirectory ? new FileObjectStore(uploadsDirectory, RECEIPT_KEY_PREFIX) : null;
  if (bucket) return new ReceiptStorage(bucket, disk ?? undefined);
  return disk ? new ReceiptStorage(disk) : null;
}
