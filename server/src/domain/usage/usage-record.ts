import { DomainError } from '../shared/domain-error.js';
import { assertValidDate } from '../shared/iso-date.js';
import { roundMeterValue } from './meter-value.js';

export interface UsageRecordProps {
  id: string;
  equipmentId: string;
  /** Membre à qui la durée est attribuée. `null` : segment en attente d'attribution. */
  memberId: string | null;
  recordedAt: Date;
  /** Relevé de compteur en fin d'utilisation (heures moteur ou km selon l'équipement). */
  meterReading: number;
  /**
   * Compteur relevé au départ. `null` quand il est inconnu (premier relevé d'un équipement,
   * ou relevé antérieur à ce champ) : la durée retombe alors sur le relevé précédent.
   */
  startReading?: number | null;
  fuelAddedLiters?: number | null;
  notes?: string | null;
  /** true si ce relevé correspond à une maintenance déclarée. */
  isMaintenance?: boolean;
}

/**
 * Relevé saisi manuellement à chaque fin d'utilisation.
 *
 * Il porte son propre point de départ : sans lui, la durée d'un relevé se déduisait du relevé
 * précédent, et les heures d'un membre qui oublie sa saisie tombaient en silence sur le suivant.
 * Un relevé sans membre est un segment que le cercle a constaté sans savoir (encore) à qui il est.
 */
export class UsageRecord {
  private constructor(
    readonly id: string,
    readonly equipmentId: string,
    readonly memberId: string | null,
    readonly recordedAt: Date,
    readonly meterReading: number,
    readonly startReading: number | null,
    readonly fuelAddedLiters: number | null,
    readonly notes: string | null,
    readonly isMaintenance: boolean,
  ) {}

  static create(props: UsageRecordProps): UsageRecord {
    if (!Number.isFinite(props.meterReading) || props.meterReading < 0) {
      throw new DomainError('Le relevé de compteur doit être un nombre positif.');
    }
    if (props.startReading != null && (!Number.isFinite(props.startReading) || props.startReading < 0)) {
      throw new DomainError('Le compteur au départ doit être un nombre positif.');
    }
    if (props.startReading != null && props.startReading > props.meterReading) {
      throw new DomainError(
        `Le compteur au départ (${props.startReading}) ne peut pas dépasser celui d'arrivée (${props.meterReading}).`,
      );
    }
    if (props.fuelAddedLiters != null && (!Number.isFinite(props.fuelAddedLiters) || props.fuelAddedLiters < 0)) {
      throw new DomainError('La quantité de carburant doit être positive.');
    }
    assertValidDate(props.recordedAt, 'La date du relevé');
    return new UsageRecord(
      props.id,
      props.equipmentId,
      props.memberId,
      new Date(props.recordedAt),
      roundMeterValue(props.meterReading),
      props.startReading == null ? null : roundMeterValue(props.startReading),
      props.fuelAddedLiters == null ? null : roundMeterValue(props.fuelAddedLiters),
      props.notes?.trim() || null,
      props.isMaintenance ?? false,
    );
  }
}
