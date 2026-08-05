import { FileObjectStore, MediaStorage, createS3ObjectStore } from './object-store.js';
import type { MediaDelivery } from './object-store.js';
import { RICH_CONTENT_TYPES } from './document-storage.js';

/** Préfixe des clés de pièces jointes, distinct des justificatifs et des documents du même bucket. */
export const ATTACHMENT_PREFIX = 'attachments/';

export type AttachmentDelivery = MediaDelivery;

/**
 * Pièces jointes des messages de discussion. Elles acceptent exactement les mêmes formats que les
 * documents d'un équipement — c'est le même geste, montrer un fichier à son cercle — mais vivent
 * sous leur propre préfixe : une pièce jointe suit son message, elle n'entre pas dans le dossier.
 */
export type AttachmentStorage = MediaStorage;

/**
 * Stockage des pièces jointes choisi par l'environnement, comme celui des documents : bucket S3/R2
 * dès que ses quatre variables sont présentes, sinon le répertoire — qui lui sert de repli en
 * lecture quand le bucket arrive après coup.
 */
export function createAttachmentStorage(
  env: NodeJS.ProcessEnv,
  fallbackDirectory: string | null,
): AttachmentStorage | null {
  const bucket = createS3ObjectStore(env);
  const disk = fallbackDirectory ? new FileObjectStore(fallbackDirectory, ATTACHMENT_PREFIX) : null;
  const policy = { keyPrefix: ATTACHMENT_PREFIX, contentTypes: RICH_CONTENT_TYPES };
  if (bucket) return new MediaStorage(bucket, policy, disk ?? undefined);
  return disk ? new MediaStorage(disk, policy) : null;
}
