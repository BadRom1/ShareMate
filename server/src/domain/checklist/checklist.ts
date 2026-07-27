import { DomainError } from '../shared/domain-error.js';

export interface ChecklistProps {
  id: string;
  equipmentId: string;
  authorId: string;
  title: string;
  createdAt: Date;
  updatedAt?: Date | null;
}

/** Longueur maximale du titre d'une checklist. */
const MAX_TITLE_LENGTH = 200;

/**
 * Checklist rattachée à un équipement (ex. « Avant utilisation », « Hivernage »).
 * Un membre peut en créer autant qu'il veut par équipement ; elle regroupe des points
 * de contrôle (`ChecklistItem`) que le cercle coche au fil de l'utilisation.
 */
export class Checklist {
  private constructor(
    readonly id: string,
    readonly equipmentId: string,
    readonly authorId: string,
    readonly title: string,
    readonly createdAt: Date,
    /** Dernière activité (création, ajout ou coche d'un point), pour trier les checklists. */
    readonly updatedAt: Date,
  ) {}

  static create(props: ChecklistProps): Checklist {
    const title = props.title.trim();
    if (title.length === 0) {
      throw new DomainError('Le titre de la checklist est requis.');
    }
    if (title.length > MAX_TITLE_LENGTH) {
      throw new DomainError(`Le titre est trop long (max ${MAX_TITLE_LENGTH} caractères).`);
    }
    return new Checklist(
      props.id,
      props.equipmentId,
      props.authorId,
      title,
      props.createdAt,
      props.updatedAt ?? props.createdAt,
    );
  }

  /** Renomme la checklist (copie immuable). */
  rename(title: string, at: Date): Checklist {
    return Checklist.create({
      id: this.id,
      equipmentId: this.equipmentId,
      authorId: this.authorId,
      title,
      createdAt: this.createdAt,
      updatedAt: at,
    });
  }

  /** Marque une nouvelle activité (copie immuable). */
  touch(at: Date): Checklist {
    return new Checklist(this.id, this.equipmentId, this.authorId, this.title, this.createdAt, at);
  }
}
