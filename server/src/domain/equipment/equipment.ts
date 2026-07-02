import { DomainError } from '../shared/domain-error.js';
import type { Money } from '../shared/money.js';

/** Unité du compteur : heures moteur ou kilométrage. */
export type MeterUnit = 'HOURS' | 'KILOMETERS';

export interface EquipmentProps {
  id: string;
  groupId: string;
  name: string;
  category: string;
  acquisitionDate: Date;
  purchaseValue: Money;
  meterUnit: MeterUnit;
  accessMemberIds: string[];
  /** Seuil (heures/km) depuis la dernière maintenance déclenchant une alerte. */
  maintenanceThreshold: number | null;
}

export interface EquipmentUpdate {
  name?: string;
  category?: string;
  acquisitionDate?: Date;
  purchaseValue?: Money;
  meterUnit?: MeterUnit;
  accessMemberIds?: string[];
  maintenanceThreshold?: number | null;
}

/**
 * Équipement partagé. Il appartient à un groupe (pas de propriétaire unique) ;
 * `accessMemberIds` liste les membres autorisés à l'utiliser.
 */
export class Equipment {
  private constructor(
    readonly id: string,
    readonly groupId: string,
    readonly name: string,
    readonly category: string,
    readonly acquisitionDate: Date,
    readonly purchaseValue: Money,
    readonly meterUnit: MeterUnit,
    readonly accessMemberIds: readonly string[],
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
    const accessMemberIds = [...new Set(props.accessMemberIds)];
    if (accessMemberIds.length === 0) {
      throw new DomainError('Au moins un membre doit avoir accès à l\'équipement.');
    }
    if (props.maintenanceThreshold !== null && props.maintenanceThreshold <= 0) {
      throw new DomainError('Le seuil de maintenance doit être strictement positif.');
    }
    return new Equipment(
      props.id,
      props.groupId,
      name,
      props.category.trim(),
      new Date(props.acquisitionDate),
      props.purchaseValue,
      props.meterUnit,
      accessMemberIds,
      props.maintenanceThreshold,
    );
  }

  canBeUsedBy(memberId: string): boolean {
    return this.accessMemberIds.includes(memberId);
  }

  update(changes: EquipmentUpdate): Equipment {
    return Equipment.create({
      id: this.id,
      groupId: this.groupId,
      name: changes.name ?? this.name,
      category: changes.category ?? this.category,
      acquisitionDate: changes.acquisitionDate ?? this.acquisitionDate,
      purchaseValue: changes.purchaseValue ?? this.purchaseValue,
      meterUnit: changes.meterUnit ?? this.meterUnit,
      accessMemberIds: changes.accessMemberIds ?? [...this.accessMemberIds],
      maintenanceThreshold:
        changes.maintenanceThreshold !== undefined ? changes.maintenanceThreshold : this.maintenanceThreshold,
    });
  }
}
