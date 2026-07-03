import { DomainError } from '../shared/domain-error.js';
import type { Money } from '../shared/money.js';

/** Unité du compteur : heures moteur ou kilométrage. */
export type MeterUnit = 'HOURS' | 'KILOMETERS';

export interface EquipmentProps {
  id: string;
  name: string;
  category: string;
  acquisitionDate: Date;
  purchaseValue: Money;
  meterUnit: MeterUnit;
  memberIds: string[];
  /** Seuil (heures/km) depuis la dernière maintenance déclenchant une alerte. */
  maintenanceThreshold: number | null;
}

export interface EquipmentUpdate {
  name?: string;
  category?: string;
  acquisitionDate?: Date;
  purchaseValue?: Money;
  meterUnit?: MeterUnit;
  memberIds?: string[];
  maintenanceThreshold?: number | null;
}

/**
 * Équipement partagé. C'est lui qui porte son cercle d'utilisateurs :
 * `memberIds` liste les membres qui le partagent (réservations, dépenses, soldes).
 */
export class Equipment {
  private constructor(
    readonly id: string,
    readonly name: string,
    readonly category: string,
    readonly acquisitionDate: Date,
    readonly purchaseValue: Money,
    readonly meterUnit: MeterUnit,
    readonly memberIds: readonly string[],
    readonly maintenanceThreshold: number | null,
  ) {}

  static create(props: EquipmentProps): Equipment {
    const name = props.name.trim();
    if (name.length === 0) {
      throw new DomainError("Le nom de l'équipement est requis.");
    }
    if (props.purchaseValue.isNegative()) {
      throw new DomainError("La valeur d'achat ne peut pas être négative.");
    }
    const memberIds = [...new Set(props.memberIds)];
    if (memberIds.length === 0) {
      throw new DomainError("Le cercle d'un équipement doit compter au moins un utilisateur.");
    }
    if (props.maintenanceThreshold !== null && props.maintenanceThreshold <= 0) {
      throw new DomainError('Le seuil de maintenance doit être strictement positif.');
    }
    return new Equipment(
      props.id,
      name,
      props.category.trim(),
      new Date(props.acquisitionDate),
      props.purchaseValue,
      props.meterUnit,
      memberIds,
      props.maintenanceThreshold,
    );
  }

  canBeUsedBy(memberId: string): boolean {
    return this.memberIds.includes(memberId);
  }

  update(changes: EquipmentUpdate): Equipment {
    return Equipment.create({
      id: this.id,
      name: changes.name ?? this.name,
      category: changes.category ?? this.category,
      acquisitionDate: changes.acquisitionDate ?? this.acquisitionDate,
      purchaseValue: changes.purchaseValue ?? this.purchaseValue,
      meterUnit: changes.meterUnit ?? this.meterUnit,
      memberIds: changes.memberIds ?? [...this.memberIds],
      maintenanceThreshold:
        changes.maintenanceThreshold !== undefined ? changes.maintenanceThreshold : this.maintenanceThreshold,
    });
  }
}
