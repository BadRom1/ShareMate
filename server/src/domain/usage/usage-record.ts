import { DomainError } from '../shared/domain-error.js';

export interface UsageRecordProps {
  id: string;
  equipmentId: string;
  memberId: string;
  recordedAt: Date;
  /** Relevé de compteur en fin d'utilisation (heures moteur ou km selon l'équipement). */
  meterReading: number;
  fuelAddedLiters?: number | null;
  notes?: string | null;
  /** true si ce relevé correspond à une maintenance déclarée. */
  isMaintenance?: boolean;
}

/** Relevé saisi manuellement à chaque fin d'utilisation. */
export class UsageRecord {
  private constructor(
    readonly id: string,
    readonly equipmentId: string,
    readonly memberId: string,
    readonly recordedAt: Date,
    readonly meterReading: number,
    readonly fuelAddedLiters: number | null,
    readonly notes: string | null,
    readonly isMaintenance: boolean,
  ) {}

  static create(props: UsageRecordProps): UsageRecord {
    if (!Number.isFinite(props.meterReading) || props.meterReading < 0) {
      throw new DomainError('Le relevé de compteur doit être un nombre positif.');
    }
    if (props.fuelAddedLiters != null && (!Number.isFinite(props.fuelAddedLiters) || props.fuelAddedLiters < 0)) {
      throw new DomainError('La quantité de carburant doit être positive.');
    }
    return new UsageRecord(
      props.id,
      props.equipmentId,
      props.memberId,
      new Date(props.recordedAt),
      props.meterReading,
      props.fuelAddedLiters ?? null,
      props.notes?.trim() || null,
      props.isMaintenance ?? false,
    );
  }
}
