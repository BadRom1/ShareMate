import { ConflictError } from '../shared/domain-error.js';
import type { Reservation } from './reservation.js';

/**
 * Règle métier : deux réservations du même équipement ne peuvent pas se
 * chevaucher, quel que soit le membre. La réservation candidate est ignorée
 * si elle figure déjà dans la liste (cas d'une modification).
 */
export function assertNoConflict(candidate: Reservation, existing: readonly Reservation[]): void {
  const conflicting = existing.find(
    (r) =>
      r.id !== candidate.id &&
      r.equipmentId === candidate.equipmentId &&
      r.range.overlaps(candidate.range),
  );
  if (conflicting) {
    throw new ConflictError(
      `Le créneau demandé chevauche une réservation existante (du ${conflicting.range.start.toISOString()} au ${conflicting.range.end.toISOString()}).`,
    );
  }
}
