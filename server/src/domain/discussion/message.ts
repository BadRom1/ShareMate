import { DomainError } from '../shared/domain-error.js';

export interface MessageProps {
  id: string;
  threadId: string;
  authorId: string;
  body: string;
  createdAt: Date;
  editedAt?: Date | null;
}

/** Longueur maximale d'un message de discussion. */
const MAX_BODY_LENGTH = 4000;

function normalizeBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
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
  ) {}

  static create(props: MessageProps): Message {
    return new Message(
      props.id,
      props.threadId,
      props.authorId,
      normalizeBody(props.body),
      props.createdAt,
      props.editedAt ?? null,
    );
  }

  /** Modifie le corps du message et horodate l'édition (copie immuable). */
  edit(body: string, at: Date): Message {
    return new Message(this.id, this.threadId, this.authorId, normalizeBody(body), this.createdAt, at);
  }
}
