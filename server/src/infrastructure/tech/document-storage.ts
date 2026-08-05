import { FileObjectStore, MediaStorage } from './object-store.js';
import type { MediaDelivery, MediaType, ObjectStore } from './object-store.js';

/** Préfixe des clés de documents, seule forme qui circule hors de l'infrastructure. */
export const DOCUMENT_PREFIX = 'documents/';

/**
 * Extensions acceptées au dépôt d'un fichier par un membre, et type MIME servi en retour. Cette
 * politique vaut pour les documents d'un équipement **et** pour les pièces jointes d'un message :
 * ce qu'on range dans un dossier et ce qu'on montre dans une discussion sont de même nature.
 *
 * Ni exécutables, ni archives, ni HTML, ni SVG. En mode bucket, le contenu est servi depuis un
 * domaine distinct du nôtre, où une page fabriquée s'exécuterait dans son propre contexte ; en
 * repli disque, l'API le relaie depuis notre origine, et un HTML `inline` y hériterait de la
 * nôtre. La liste est la même dans les deux cas : elle doit tenir sous le plus permissif.
 */
export const RICH_CONTENT_TYPES: Record<string, MediaType> = {
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

export type DocumentDelivery = MediaDelivery;

/**
 * Documents du dossier d'un équipement. Le nom du fichier d'origine n'est pas la clé : celle-ci
 * est un UUID, et le nom ne réapparaît qu'à la lecture, porté par le `Content-Disposition`.
 */
export type DocumentStorage = MediaStorage;

/**
 * Stockage des documents choisi par l'environnement : bucket S3/R2 dès que ses quatre variables
 * sont présentes, sinon le disque — qui reste alors la seule source. Quand le bucket est là, le
 * répertoire lui sert de repli en lecture : les objets déposés avant la bascule restent lisibles.
 */
export function createDocumentStorage(
  bucket: ObjectStore | null,
  fallbackDirectory: string | null,
): DocumentStorage | null {
  const disk = fallbackDirectory ? new FileObjectStore(fallbackDirectory, DOCUMENT_PREFIX) : null;
  const policy = { keyPrefix: DOCUMENT_PREFIX, contentTypes: RICH_CONTENT_TYPES };
  if (bucket) return new MediaStorage(bucket, policy, disk ?? undefined);
  return disk ? new MediaStorage(disk, policy) : null;
}
