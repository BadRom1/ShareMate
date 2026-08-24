import { DomainError } from '../shared/domain-error.js';
import { assertValidDate } from '../shared/iso-date.js';
import type { Money } from '../shared/money.js';

/** Unité du compteur : heures moteur ou kilométrage. */
export type MeterUnit = 'HOURS' | 'KILOMETERS';

export interface EquipmentProps {
  id: string;
  name: string;
  /** Étiquette libre, purement descriptive : `null` (ou vide) quand elle n'a pas été renseignée. */
  category?: string | null;
  acquisitionDate: Date;
  /** Valeur d'achat, `null` tant qu'elle est inconnue — à distinguer d'un équipement à 0 €. */
  purchaseValue?: Money | null;
  meterUnit: MeterUnit;
  memberIds: string[];
  /** Seuil (heures/km) depuis la dernière maintenance déclenchant une alerte. */
  maintenanceThreshold: number | null;
}

export interface EquipmentUpdate {
  name?: string;
  category?: string | null;
  acquisitionDate?: Date;
  purchaseValue?: Money | null;
  meterUnit?: MeterUnit;
  memberIds?: string[];
  maintenanceThreshold?: number | null;
}

/**
 * Équipement partagé. C'est lui qui porte son cercle d'utilisateurs :
 * `memberIds` liste les membres qui le partagent (réservations, dépenses, soldes).
 *
 * Seuls le nom, la date d'acquisition, le compteur et le cercle sont exigés : ce sont les seuls
 * champs dont dépend une autre partie de l'application (l'agenda, les relevés, les soldes).
 * La catégorie et la valeur d'achat ne sont que des annotations d'affichage — les rendre
 * obligatoires ne fait qu'imposer une saisie de complaisance avant de pouvoir partager un
 * équipement.
 */
export class Equipment {
  private constructor(
    readonly id: string,
    readonly name: string,
    readonly category: string | null,
    readonly acquisitionDate: Date,
    readonly purchaseValue: Money | null,
    readonly meterUnit: MeterUnit,
    readonly memberIds: readonly string[],
    readonly maintenanceThreshold: number | null,
  ) {}

  static create(props: EquipmentProps): Equipment {
    const name = props.name.trim();
    if (name.length === 0) {
      throw new DomainError("Le nom de l'équipement est requis.");
    }
    const purchaseValue = props.purchaseValue ?? null;
    if (purchaseValue !== null && purchaseValue.isNegative()) {
      throw new DomainError("La valeur d'achat ne peut pas être négative.");
    }
    assertValidDate(props.acquisitionDate, "La date d'acquisition");
    const memberIds = [...new Set(props.memberIds)];
    if (memberIds.length === 0) {
      throw new DomainError("Le cercle d'un équipement doit compter au moins un utilisateur.");
    }
    if (props.maintenanceThreshold !== null && props.maintenanceThreshold <= 0) {
      throw new DomainError('Le seuil de maintenance doit être strictement positif.');
    }
    // Un champ facultatif laissé vide par un formulaire est une absence, pas une chaîne vide :
    // l'affichage n'a alors qu'un cas à traiter, ici comme en base.
    const category = props.category?.trim() ? props.category.trim() : null;
    return new Equipment(
      props.id,
      name,
      category,
      new Date(props.acquisitionDate),
      purchaseValue,
      props.meterUnit,
      memberIds,
      props.maintenanceThreshold,
    );
  }

  canBeUsedBy(memberId: string): boolean {
    return this.memberIds.includes(memberId);
  }

  /**
   * Champ absent de `changes` : inchangé. Champ à `null` : effacé — d'où le `!== undefined`
   * plutôt qu'un `??`, qui confondrait « ne touche pas à la catégorie » et « efface-la ».
   */
  update(changes: EquipmentUpdate): Equipment {
    return Equipment.create({
      id: this.id,
      name: changes.name ?? this.name,
      category: changes.category !== undefined ? changes.category : this.category,
      acquisitionDate: changes.acquisitionDate ?? this.acquisitionDate,
      purchaseValue: changes.purchaseValue !== undefined ? changes.purchaseValue : this.purchaseValue,
      meterUnit: changes.meterUnit ?? this.meterUnit,
      memberIds: changes.memberIds ?? [...this.memberIds],
      maintenanceThreshold:
        changes.maintenanceThreshold !== undefined ? changes.maintenanceThreshold : this.maintenanceThreshold,
    });
  }
}
