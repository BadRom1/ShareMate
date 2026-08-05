import { DomainError } from '../shared/domain-error.js';

export interface SubEquipmentProps {
  id: string;
  equipmentId: string;
  name: string;
  /** Nombre d'exemplaires dans le lot (3 godets, 2 jerricans…). */
  quantity: number;
  /** Précision libre (dimensions, état, emplacement…) ; `null` = rien à préciser. */
  notes?: string | null;
  /** Rang d'affichage dans le lot (croissant, sans garantie de contiguïté). */
  position: number;
}

export interface SubEquipmentUpdate {
  name?: string;
  quantity?: number;
  notes?: string | null;
}

const MAX_NAME_LENGTH = 120;
const MAX_NOTES_LENGTH = 500;

/** Un lot se compte, il ne s'inventorie pas : au-delà, c'est un stock, que l'application ne suit pas. */
export const MAX_QUANTITY = 999;

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new DomainError('Le nom du sous-équipement est requis.');
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new DomainError(`Le nom est trop long (max ${MAX_NAME_LENGTH} caractères).`);
  }
  return trimmed;
}

/** Une précision vide n'est pas une précision : le champ laissé blanc vaut « rien à préciser ». */
function normalizeNotes(notes: string | null | undefined): string | null {
  const trimmed = (notes ?? '').trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_NOTES_LENGTH) {
    throw new DomainError(`La précision est trop longue (max ${MAX_NOTES_LENGTH} caractères).`);
  }
  return trimmed;
}

/**
 * Élément du lot d'un équipement : la remorque de la minipelle, ses godets, sa pompe à graisse.
 *
 * Il décrit ce qui part avec l'équipement, et rien de plus : il ne se réserve pas, ne porte ni
 * compteur ni dépense. Tout cela reste au niveau de l'équipement, qui est l'unité que le cercle
 * partage — un godet ne se prête pas sans la pelle.
 */
export class SubEquipment {
  private constructor(
    readonly id: string,
    readonly equipmentId: string,
    readonly name: string,
    readonly quantity: number,
    readonly notes: string | null,
    readonly position: number,
  ) {}

  static create(props: SubEquipmentProps): SubEquipment {
    if (!Number.isInteger(props.quantity) || props.quantity < 1) {
      throw new DomainError('La quantité doit être un entier supérieur ou égal à 1.');
    }
    if (props.quantity > MAX_QUANTITY) {
      throw new DomainError(`La quantité ne peut pas dépasser ${MAX_QUANTITY}.`);
    }
    if (!Number.isInteger(props.position) || props.position < 0) {
      throw new DomainError('La position doit être un entier positif.');
    }
    return new SubEquipment(
      props.id,
      props.equipmentId,
      normalizeName(props.name),
      props.quantity,
      normalizeNotes(props.notes),
      props.position,
    );
  }

  /** Copie immuable : le rang d'affichage et le rattachement à l'équipement ne se modifient pas. */
  update(changes: SubEquipmentUpdate): SubEquipment {
    return SubEquipment.create({
      id: this.id,
      equipmentId: this.equipmentId,
      name: changes.name ?? this.name,
      quantity: changes.quantity ?? this.quantity,
      // `null` est une valeur demandée (effacer la précision), pas une absence de changement.
      notes: changes.notes !== undefined ? changes.notes : this.notes,
      position: this.position,
    });
  }
}
