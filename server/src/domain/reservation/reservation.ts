import type { TimeRange } from '../shared/time-range.js';

export interface ReservationProps {
  id: string;
  equipmentId: string;
  memberId: string;
  range: TimeRange;
  notes?: string | null;
}

/** Réservation d'un équipement par un membre sur un créneau. */
export class Reservation {
  private constructor(
    readonly id: string,
    readonly equipmentId: string,
    readonly memberId: string,
    readonly range: TimeRange,
    readonly notes: string | null,
  ) {}

  static create(props: ReservationProps): Reservation {
    return new Reservation(props.id, props.equipmentId, props.memberId, props.range, props.notes ?? null);
  }
}
