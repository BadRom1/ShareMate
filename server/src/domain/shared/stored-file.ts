import { DomainError } from './domain-error.js';

/**
 * Fichier déposé dans le stockage d'objets, tel que le domaine le connaît : une référence opaque
 * et ce qu'il faut pour l'annoncer. Où et comment l'objet est rangé ne le regarde pas.
 *
 * Un document d'équipement et une pièce jointe de message portent la même chose ; la forme et ses
 * bornes vivent donc ici plutôt qu'en double dans chaque domaine.
 */
export interface StoredFile {
  /** Clé de l'objet dans le stockage, jamais interprétée à ce niveau. */
  storageKey: string;
  /** Nom d'origine, celui que le membre retrouvera sur son poste. */
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

const MAX_FILE_NAME_LENGTH = 255;
const MAX_CONTENT_TYPE_LENGTH = 100;

/** Poids maximal d'un fichier déposé (25 Mo) : borne du domaine, doublée côté téléversement. */
export const MAX_STORED_FILE_BYTES = 25 * 1024 * 1024;

/** Fichier normalisé, ou refus motivé. Le subject nomme la chose au membre (« la pièce jointe »). */
export function validateStoredFile(file: StoredFile, subject: string): StoredFile {
  const storageKey = file.storageKey.trim();
  const fileName = file.fileName.trim();
  const contentType = file.contentType.trim();
  if (storageKey.length === 0) {
    throw new DomainError(`La référence de ${subject} est requise.`);
  }
  if (fileName.length === 0 || fileName.length > MAX_FILE_NAME_LENGTH) {
    throw new DomainError(`Le nom de fichier est requis (max ${MAX_FILE_NAME_LENGTH} caractères).`);
  }
  if (contentType.length === 0 || contentType.length > MAX_CONTENT_TYPE_LENGTH) {
    throw new DomainError(`Le type de contenu de ${subject} est requis.`);
  }
  if (!Number.isInteger(file.sizeBytes) || file.sizeBytes <= 0) {
    throw new DomainError('Le poids du fichier doit être un nombre entier d’octets strictement positif.');
  }
  if (file.sizeBytes > MAX_STORED_FILE_BYTES) {
    throw new DomainError(`Le fichier dépasse ${MAX_STORED_FILE_BYTES / (1024 * 1024)} Mo.`);
  }
  return { storageKey, fileName, contentType, sizeBytes: file.sizeBytes };
}
