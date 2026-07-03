import type { TimeRange } from '../shared/time-range.js';

/** PLANNED = prévisionnel (souple), REQUIRED = nécessaire/obligatoire (ferme). */
export type ReservationStatus = 'PLANNED' | 'REQUIRED';

export interface ReservationProps {
  id: string;
  equipmentId: string;
  memberId: string;
  range: TimeRange;
  status?: ReservationStatus;
  createdAt?: Date;
  notes?: string | null;
}

/** Réservation d'un équipement par un membre sur un créneau. */
export class Reservation {
  private constructor(
    readonly id: string,
    readonly equipmentId: string,
    readonly memberId: string,
    readonly range: TimeRange,
    readonly status: ReservationStatus,
    readonly createdAt: Date,
    readonly notes: string | null,
  ) {}

  static create(props: ReservationProps): Reservation {
    return new Reservation(
      props.id,
      props.equipmentId,
      props.memberId,
      props.range,
      props.status ?? 'REQUIRED',
      props.createdAt ?? new Date(0),
      props.notes ?? null,
    );
  }
}
