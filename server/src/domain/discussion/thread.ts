import { DomainError } from '../shared/domain-error.js';

export interface ThreadProps {
  id: string;
  equipmentId: string;
  authorId: string;
  title: string;
  createdAt: Date;
  updatedAt?: Date | null;
}

/** Longueur maximale du titre d'un fil. */
const MAX_TITLE_LENGTH = 200;

/** Fil de discussion rattaché à un équipement ; regroupe des messages. */
export class Thread {
  private constructor(
    readonly id: string,
    readonly equipmentId: string,
    readonly authorId: string,
    readonly title: string,
    readonly createdAt: Date,
    /** Dernière activité (création ou dernier message), pour trier les fils. */
    readonly updatedAt: Date,
  ) {}

  static create(props: ThreadProps): Thread {
    const title = props.title.trim();
    if (title.length === 0) {
      throw new DomainError('Le titre du fil est requis.');
    }
    if (title.length > MAX_TITLE_LENGTH) {
      throw new DomainError(`Le titre est trop long (max ${MAX_TITLE_LENGTH} caractères).`);
    }
    return new Thread(
      props.id,
      props.equipmentId,
      props.authorId,
      title,
      props.createdAt,
      props.updatedAt ?? props.createdAt,
    );
  }

  /** Renomme le fil (copie immuable). */
  rename(title: string, at: Date): Thread {
    return Thread.create({
      id: this.id,
      equipmentId: this.equipmentId,
      authorId: this.authorId,
      title,
      createdAt: this.createdAt,
      updatedAt: at,
    });
  }

  /** Marque une nouvelle activité (copie immuable). */
  touch(at: Date): Thread {
    return new Thread(this.id, this.equipmentId, this.authorId, this.title, this.createdAt, at);
  }
}
