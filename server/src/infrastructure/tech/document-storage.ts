import { FileObjectStore, MediaStorage, createS3ObjectStore } from './object-store.js';
import type { MediaDelivery, MediaType, ObjectStore } from './object-store.js';
import type { ObjectStorage } from '../../application/ports.js';

/** Préfixe des clés de documents, seule forme qui circule hors de l'infrastructure. */
export const DOCUMENT_PREFIX = 'documents/';

/**
 * Extensions acceptées au dépôt d'un document, et type MIME servi en retour.
 *
 * Ni exécutables, ni archives, ni HTML, ni SVG : le contenu d'un objet est servi depuis le domaine
 * du bucket, distinct du nôtre, où une page fabriquée s'exécuterait dans son propre contexte.
 */
const CONTENT_TYPES: Record<string, MediaType> = {
  '.pdf': { type: 'application/pdf', inline: true },
  '.png': { type: 'image/png', inline: true },
  '.jpg': { type: 'image/jpeg', inline: true },
  '.jpeg': { type: 'image/jpeg', inline: true },
  '.webp': { type: 'image/webp', inline: true },
  '.gif': { type: 'image/gif', inline: true },
  '.txt': { type: 'text/plain; charset=utf-8', inline: false },
  '.csv': { type: 'text/csv; charset=utf-8', inline: false },
  '.doc': { type: 'application/msword', inline: false },
  '.docx': { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', inline: false },
  '.xls': { type: 'application/vnd.ms-excel', inline: false },
  '.xlsx': { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', inline: false },
  '.ppt': { type: 'application/vnd.ms-powerpoint', inline: false },
  '.pptx': { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', inline: false },
  '.odt': { type: 'application/vnd.oasis.opendocument.text', inline: false },
  '.ods': { type: 'application/vnd.oasis.opendocument.spreadsheet', inline: false },
  '.odp': { type: 'application/vnd.oasis.opendocument.presentation', inline: false },
};

/** Clé telle que `save` la produit : préfixe + UUID v4 + extension acceptée. */
const DOCUMENT_KEY = new RegExp(
  `^${DOCUMENT_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` +
    `\\.(${Object.keys(CONTENT_TYPES)
      .map((extension) => extension.slice(1))
      .join('|')})$`,
);

export type DocumentDelivery = MediaDelivery;

/**
 * Documents du dossier d'un équipement. Le nom du fichier d'origine n'est pas la clé : celle-ci
 * est un UUID, et le nom ne réapparaît qu'à la lecture, porté par le `Content-Disposition`.
 */
export class DocumentStorage implements ObjectStorage {
  private readonly media: MediaStorage;

  constructor(primary: ObjectStore, legacy?: ObjectStore) {
    this.media = new MediaStorage(primary, { keyPrefix: DOCUMENT_PREFIX, contentTypes: CONTENT_TYPES }, legacy);
  }

  supports(extension: string): boolean {
    return this.media.supports(extension);
  }

  contentType(extension: string): string {
    return this.media.contentType(extension);
  }

  extensions(): string[] {
    return this.media.extensions();
  }

  save(content: Buffer, extension: string): Promise<string> {
    return this.media.save(content, extension);
  }

  /** Contenu prêt à être servi, ou `null` si la clé n'a pas la forme que `save` produit. */
  async open(storageKey: string, fileName: string): Promise<DocumentDelivery | null> {
    return DOCUMENT_KEY.test(storageKey) ? this.media.open(storageKey, fileName) : null;
  }

  async delete(storageKey: string): Promise<void> {
    if (DOCUMENT_KEY.test(storageKey)) await this.media.delete(storageKey);
  }
}

/**
 * Stockage des documents choisi par l'environnement : bucket S3/R2 dès que ses quatre variables
 * sont présentes, sinon le disque — qui reste alors la seule source. Quand le bucket est là, le
 * répertoire lui sert de repli en lecture : les objets déposés avant la bascule restent lisibles.
 */
export function createDocumentStorage(
  env: NodeJS.ProcessEnv,
  fallbackDirectory: string | null,
): DocumentStorage | null {
  const bucket = createS3ObjectStore(env);
  const disk = fallbackDirectory ? new FileObjectStore(fallbackDirectory, DOCUMENT_PREFIX) : null;
  if (bucket) return new DocumentStorage(bucket, disk ?? undefined);
  return disk ? new DocumentStorage(disk) : null;
}
