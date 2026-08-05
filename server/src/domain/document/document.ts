import { DomainError } from '../shared/domain-error.js';
import { assertValidDate } from '../shared/iso-date.js';

/** Familles d'un dossier d'équipement, dans l'ordre d'affichage. Fixes, comme celles des dépenses. */
export type DocumentCategory = 'MANUAL' | 'INSURANCE' | 'PURCHASE' | 'MAINTENANCE' | 'PHOTO' | 'OTHER';

export const DOCUMENT_CATEGORIES: readonly DocumentCategory[] = [
  'MANUAL',
  'INSURANCE',
  'PURCHASE',
  'MAINTENANCE',
  'PHOTO',
  'OTHER',
];

/**
 * Fichier déposé dans le stockage d'objets. `storageKey` est opaque pour le domaine : où et
 * comment l'objet est rangé ne le regarde pas, il n'en garde que la référence et ce qu'il faut
 * pour l'annoncer (nom d'origine, type, poids).
 */
export interface StoredFile {
  type: 'FILE';
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

/** Lien externe : ShareMate n'en stocke que l'adresse, jamais le contenu. */
export interface ExternalLink {
  type: 'LINK';
  url: string;
}

/** Deux natures, un seul objet : le membre range un manuel PDF et un tutoriel vidéo côte à côte. */
export type DocumentContent = StoredFile | ExternalLink;

export interface DocumentProps {
  id: string;
  equipmentId: string;
  authorId: string;
  name: string;
  category: DocumentCategory;
  content: DocumentContent;
  createdAt: Date;
}

export interface DocumentUpdate {
  name?: string;
  category?: DocumentCategory;
}

const MAX_NAME_LENGTH = 200;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_CONTENT_TYPE_LENGTH = 100;
const MAX_URL_LENGTH = 2000;

/** Poids maximal d'un fichier déposé (25 Mo) : borne du domaine, doublée côté téléversement. */
export const MAX_DOCUMENT_SIZE_BYTES = 25 * 1024 * 1024;

/**
 * Seuls schémas qu'un lien peut porter. Un lien du dossier est rendu cliquable pour tout le
 * cercle : `javascript:` y exécuterait du code dans la session de celui qui clique, et `data:`
 * y afficherait une page fabriquée sous l'apparence du domaine de l'application.
 */
const ALLOWED_SCHEMES = ['http:', 'https:'];

/**
 * Adresse d'un lien, normalisée et bornée aux schémas navigables.
 *
 * La validation passe par `new URL` plutôt que par une expression régulière : les formes qu'un
 * navigateur accepte réellement (identifiants, IPv6, IDN, port implicite) sont trop nombreuses
 * pour être décrites à la main, et c'est ce que le navigateur accepte — pas ce qu'un motif
 * décrit — qui détermine ce qui sera ouvert au clic.
 */
export function normalizeDocumentUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new DomainError('L’adresse du lien est requise.');
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new DomainError(`L’adresse est trop longue (max ${MAX_URL_LENGTH} caractères).`);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new DomainError(`L’adresse n’est pas une URL valide : ${trimmed}`);
  }
  if (!ALLOWED_SCHEMES.includes(url.protocol)) {
    throw new DomainError('Un lien doit commencer par http:// ou https://.');
  }
  if (url.hostname.length === 0) {
    throw new DomainError(`L’adresse ne désigne aucun serveur : ${trimmed}`);
  }
  return trimmed;
}

function validateContent(content: DocumentContent): DocumentContent {
  if (content.type === 'LINK') {
    return { type: 'LINK', url: normalizeDocumentUrl(content.url) };
  }
  const storageKey = content.storageKey.trim();
  const fileName = content.fileName.trim();
  if (storageKey.length === 0) {
    throw new DomainError('La référence du fichier stocké est requise.');
  }
  if (fileName.length === 0 || fileName.length > MAX_FILE_NAME_LENGTH) {
    throw new DomainError(`Le nom de fichier est requis (max ${MAX_FILE_NAME_LENGTH} caractères).`);
  }
  if (content.contentType.trim().length === 0 || content.contentType.length > MAX_CONTENT_TYPE_LENGTH) {
    throw new DomainError('Le type de contenu du fichier est requis.');
  }
  if (!Number.isInteger(content.sizeBytes) || content.sizeBytes <= 0) {
    throw new DomainError('Le poids du fichier doit être un nombre entier d’octets strictement positif.');
  }
  if (content.sizeBytes > MAX_DOCUMENT_SIZE_BYTES) {
    throw new DomainError(`Le fichier dépasse ${MAX_DOCUMENT_SIZE_BYTES / (1024 * 1024)} Mo.`);
  }
  return { ...content, storageKey, fileName, contentType: content.contentType.trim() };
}

/**
 * Document rattaché à un équipement : manuel, certificat d'assurance, facture, photo, ou lien
 * externe. Comme une checklist, il **appartient au cercle et non à son déposant** — tout membre
 * peut le renommer, le reclasser et le supprimer. `authorId` garde la trace de qui l'a déposé.
 */
export class Document {
  private constructor(
    readonly id: string,
    readonly equipmentId: string,
    readonly authorId: string,
    readonly name: string,
    readonly category: DocumentCategory,
    readonly content: DocumentContent,
    readonly createdAt: Date,
  ) {}

  static create(props: DocumentProps): Document {
    const name = props.name.trim();
    if (name.length === 0) {
      throw new DomainError('Le nom du document est requis.');
    }
    if (name.length > MAX_NAME_LENGTH) {
      throw new DomainError(`Le nom est trop long (max ${MAX_NAME_LENGTH} caractères).`);
    }
    if (!DOCUMENT_CATEGORIES.includes(props.category)) {
      throw new DomainError(`Catégorie de document inconnue : ${props.category}`);
    }
    assertValidDate(props.createdAt, 'La date de dépôt');
    return new Document(
      props.id,
      props.equipmentId,
      props.authorId,
      name,
      props.category,
      validateContent(props.content),
      new Date(props.createdAt),
    );
  }

  /** Renomme ou reclasse le document (copie immuable) ; sa nature, elle, ne change pas. */
  update(changes: DocumentUpdate): Document {
    return Document.create({
      id: this.id,
      equipmentId: this.equipmentId,
      authorId: this.authorId,
      name: changes.name ?? this.name,
      category: changes.category ?? this.category,
      content: this.content,
      createdAt: this.createdAt,
    });
  }

  /** Référence de l'objet stocké, ou `null` pour un lien : ce qui reste à purger à la suppression. */
  get storageKey(): string | null {
    return this.content.type === 'FILE' ? this.content.storageKey : null;
  }

  /** Octets occupés dans le stockage : un lien ne pèse rien, il n'y est pas. */
  get sizeBytes(): number {
    return this.content.type === 'FILE' ? this.content.sizeBytes : 0;
  }
}
