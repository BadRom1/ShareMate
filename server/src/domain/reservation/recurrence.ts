import { DomainError } from '../shared/domain-error.js';
import { TimeRange } from '../shared/time-range.js';

export type RecurrenceFrequency = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';

export const MAX_OCCURRENCES = 52;

/** Ajoute des mois en restant dans le mois cible (31 janv. + 1 mois → 28/29 févr.). */
function addMonthsClamped(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, lastDay));
  return result;
}

function shift(date: Date, frequency: RecurrenceFrequency, step: number): Date {
  if (frequency === 'MONTHLY') {
    return addMonthsClamped(date, step);
  }
  const result = new Date(date);
  result.setDate(result.getDate() + step * (frequency === 'WEEKLY' ? 7 : 14));
  return result;
}

/**
 * Génère les créneaux d'une réservation récurrente : le créneau initial puis
 * ses répétitions, tant que leur début reste au plus tard à `until` (inclus).
 */
export function generateOccurrences(range: TimeRange, frequency: RecurrenceFrequency, until: Date): TimeRange[] {
  if (Number.isNaN(until.getTime())) {
    throw new DomainError('Date de fin de répétition invalide.');
  }
  if (until.getTime() < range.start.getTime()) {
    throw new DomainError('La fin de répétition doit être après le début du premier créneau.');
  }
  const occurrences: TimeRange[] = [];
  for (let step = 0; ; step += 1) {
    const start = shift(range.start, frequency, step);
    if (start.getTime() > until.getTime()) break;
    if (occurrences.length >= MAX_OCCURRENCES) {
      throw new DomainError(`Trop d'occurrences : la répétition est limitée à ${MAX_OCCURRENCES} créneaux.`);
    }
    occurrences.push(TimeRange.create(start, shift(range.end, frequency, step)));
  }
  return occurrences;
}
