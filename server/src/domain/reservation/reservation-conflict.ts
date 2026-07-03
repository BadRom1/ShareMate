import type { Reservation } from './reservation.js';

/**
 * Deux réservations du même équipement peuvent se chevaucher : le conflit
 * n'est pas bloquant, il est signalé. La réservation candidate est ignorée
 * si elle figure déjà dans la liste (cas d'une modification).
 */
export function findConflicts(candidate: Reservation, existing: readonly Reservation[]): Reservation[] {
  return existing.filter(
    (r) => r.id !== candidate.id && r.equipmentId === candidate.equipmentId && r.range.overlaps(candidate.range),
  );
}

/**
 * Règle de priorité en cas de conflit : une réservation obligatoire (REQUIRED)
 * l'emporte sur un prévisionnel (PLANNED) ; à statut égal, le premier arrivé
 * (createdAt le plus ancien) a la priorité.
 */
export function hasPriorityOver(a: Reservation, b: Reservation): boolean {
  if (a.status !== b.status) {
    return a.status === 'REQUIRED';
  }
  return a.createdAt.getTime() < b.createdAt.getTime();
}

/** Ids des réservations en conflit, pour chaque réservation de la liste. */
export function conflictMap(reservations: readonly Reservation[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const r of reservations) {
    map.set(
      r.id,
      findConflicts(r, reservations).map((c) => c.id),
    );
  }
  return map;
}
