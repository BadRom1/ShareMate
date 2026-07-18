import { DomainError } from '../shared/domain-error.js';

export interface MessageProps {
  id: string;
  equipmentId: string;
  authorId: string;
  body: string;
  createdAt: Date;
  editedAt?: Date | null;
}

/** Longueur maximale d'un message de discussion. */
const MAX_BODY_LENGTH = 4000;

/** Message posté sur le fil de discussion d'un équipement. */
export class Message {
  private constructor(
    readonly id: string,
    readonly equipmentId: string,
    readonly authorId: string,
    readonly body: string,
    readonly createdAt: Date,
    readonly editedAt: Date | null,
  ) {}

  static create(props: MessageProps): Message {
    const body = props.body.trim();
    if (body.length === 0) {
      throw new DomainError('Le message ne peut pas être vide.');
    }
    if (body.length > MAX_BODY_LENGTH) {
      throw new DomainError(`Le message est trop long (max ${MAX_BODY_LENGTH} caractères).`);
    }
    return new Message(props.id, props.equipmentId, props.authorId, body, props.createdAt, props.editedAt ?? null);
  }
}
