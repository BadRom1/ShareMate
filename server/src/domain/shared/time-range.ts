import { DomainError } from './domain-error.js';

/**
 * Créneau temporel [start, end) — la borne de fin est exclusive :
 * deux créneaux adjacents ne se chevauchent pas.
 */
export class TimeRange {
  private constructor(
    readonly start: Date,
    readonly end: Date,
  ) {}

  static create(start: Date, end: Date): TimeRange {
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new DomainError('Dates de créneau invalides.');
    }
    if (end.getTime() <= start.getTime()) {
      throw new DomainError('La fin du créneau doit être strictement après le début.');
    }
    return new TimeRange(new Date(start), new Date(end));
  }

  overlaps(other: TimeRange): boolean {
    return this.start.getTime() < other.end.getTime() && other.start.getTime() < this.end.getTime();
  }

  durationHours(): number {
    return (this.end.getTime() - this.start.getTime()) / 3_600_000;
  }
}
