import { DomainError } from '../shared/domain-error.js';

export interface ChecklistItemProps {
  id: string;
  checklistId: string;
  label: string;
  /** Rang d'affichage dans la checklist (croissant, sans garantie de contiguïté). */
  position: number;
  /** Horodatage de la coche ; `null` = point non fait. */
  checkedAt?: Date | null;
  /** Membre ayant coché le point ; `null` = point non fait. */
  checkedById?: string | null;
}

/** Longueur maximale du libellé d'un point de contrôle. */
const MAX_LABEL_LENGTH = 200;

function normalizeLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    throw new DomainError('Le libellé du point de contrôle est requis.');
  }
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new DomainError(`Le libellé est trop long (max ${MAX_LABEL_LENGTH} caractères).`);
  }
  return trimmed;
}

/** Point de contrôle d'une checklist : un libellé, coché ou non, et par qui. */
export class ChecklistItem {
  private constructor(
    readonly id: string,
    readonly checklistId: string,
    readonly label: string,
    readonly position: number,
    readonly checkedAt: Date | null,
    readonly checkedById: string | null,
  ) {}

  static create(props: ChecklistItemProps): ChecklistItem {
    if (!Number.isInteger(props.position) || props.position < 0) {
      throw new DomainError('La position doit être un entier positif.');
    }
    const checkedAt = props.checkedAt ?? null;
    const checkedById = props.checkedById ?? null;
    // Les deux marques de coche vont de pair : un point coché sait toujours par qui et quand.
    if ((checkedAt === null) !== (checkedById === null)) {
      throw new DomainError('Un point coché doit porter à la fois son auteur et sa date.');
    }
    return new ChecklistItem(
      props.id,
      props.checklistId,
      normalizeLabel(props.label),
      props.position,
      checkedAt,
      checkedById,
    );
  }

  get isChecked(): boolean {
    return this.checkedAt !== null;
  }

  /** Coche le point au nom d'un membre (copie immuable). Recocher réattribue la coche. */
  check(memberId: string, at: Date): ChecklistItem {
    return new ChecklistItem(this.id, this.checklistId, this.label, this.position, at, memberId);
  }

  /** Décoche le point (copie immuable). */
  uncheck(): ChecklistItem {
    return new ChecklistItem(this.id, this.checklistId, this.label, this.position, null, null);
  }

  /** Change le libellé sans toucher à l'état de la coche (copie immuable). */
  relabel(label: string): ChecklistItem {
    return new ChecklistItem(
      this.id,
      this.checklistId,
      normalizeLabel(label),
      this.position,
      this.checkedAt,
      this.checkedById,
    );
  }
}
