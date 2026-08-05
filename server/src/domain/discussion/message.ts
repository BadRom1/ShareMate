import { DomainError } from '../shared/domain-error.js';
import { validateStoredFile } from '../shared/stored-file.js';
import type { StoredFile } from '../shared/stored-file.js';

/** Fichier joint à un message : une photo de la panne, un devis, une notice. */
export type MessageAttachment = StoredFile;

export interface MessageProps {
  id: string;
  threadId: string;
  authorId: string;
  body: string;
  createdAt: Date;
  editedAt?: Date | null;
  /** Message parent auquel celui-ci répond (sous-fil). `null` = message racine du fil. */
  parentId?: string | null;
  /** Fichier joint, ou `null`. Un message en porte au plus un. */
  attachment?: MessageAttachment | null;
}

/** Longueur maximale d'un message de discussion. */
const MAX_BODY_LENGTH = 4000;

/**
 * Corps du message. Il peut être vide **si** un fichier est joint : envoyer une photo sans
 * commentaire est un geste normal dans une discussion, et exiger un texte pour l'accompagner
 * ferait écrire « voilà » à tout le monde.
 */
function normalizeBody(body: string, hasAttachment: boolean): string {
  const trimmed = body.trim();
  if (trimmed.length === 0 && !hasAttachment) {
    throw new DomainError('Le message ne peut pas être vide.');
  }
  if (trimmed.length > MAX_BODY_LENGTH) {
    throw new DomainError(`Le message est trop long (max ${MAX_BODY_LENGTH} caractères).`);
  }
  return trimmed;
}

/** Message posté dans un fil de discussion. */
export class Message {
  private constructor(
    readonly id: string,
    readonly threadId: string,
    readonly authorId: string,
    readonly body: string,
    readonly createdAt: Date,
    readonly editedAt: Date | null,
    readonly parentId: string | null,
    readonly attachment: MessageAttachment | null,
  ) {}

  static create(props: MessageProps): Message {
    const attachment = props.attachment ? validateStoredFile(props.attachment, 'la pièce jointe') : null;
    return new Message(
      props.id,
      props.threadId,
      props.authorId,
      normalizeBody(props.body, attachment !== null),
      props.createdAt,
      props.editedAt ?? null,
      props.parentId ?? null,
      attachment,
    );
  }

  /**
   * Modifie le corps du message et horodate l'édition (copie immuable). La pièce jointe, elle, ne
   * se remplace pas : elle a été vue par le cercle, et la changer sous le même message réécrirait
   * ce que les autres ont lu. On supprime et on reposte.
   */
  edit(body: string, at: Date): Message {
    return new Message(
      this.id,
      this.threadId,
      this.authorId,
      normalizeBody(body, this.attachment !== null),
      this.createdAt,
      at,
      this.parentId,
      this.attachment,
    );
  }

  /** Référence de l'objet joint, ou `null` : ce qui reste à purger à la suppression. */
  get storageKey(): string | null {
    return this.attachment?.storageKey ?? null;
  }
}
