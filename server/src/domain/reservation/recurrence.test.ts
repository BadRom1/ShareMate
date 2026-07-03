import { describe, expect, it } from 'vitest';
import { TimeRange } from '../shared/time-range.js';
import { DomainError } from '../shared/domain-error.js';
import { generateOccurrences, MAX_OCCURRENCES } from './recurrence.js';

const range = (start: string, end: string) => TimeRange.create(new Date(start), new Date(end));

describe('generateOccurrences', () => {
  const base = range('2026-07-04T08:00:00Z', '2026-07-04T18:00:00Z');

  it("hebdomadaire : une occurrence par semaine jusqu'à la borne incluse", () => {
    const occurrences = generateOccurrences(base, 'WEEKLY', new Date('2026-07-25T23:59:59Z'));
    expect(occurrences.map((o) => o.start.toISOString())).toEqual([
      '2026-07-04T08:00:00.000Z',
      '2026-07-11T08:00:00.000Z',
      '2026-07-18T08:00:00.000Z',
      '2026-07-25T08:00:00.000Z',
    ]);
    expect(occurrences.at(3)?.end.toISOString()).toBe('2026-07-25T18:00:00.000Z');
  });

  it('toutes les deux semaines', () => {
    const occurrences = generateOccurrences(base, 'BIWEEKLY', new Date('2026-08-01T23:59:59Z'));
    expect(occurrences.map((o) => o.start.toISOString())).toEqual([
      '2026-07-04T08:00:00.000Z',
      '2026-07-18T08:00:00.000Z',
      '2026-08-01T08:00:00.000Z',
    ]);
  });

  it('mensuel : conserve le jour du mois', () => {
    const occurrences = generateOccurrences(base, 'MONTHLY', new Date('2026-09-30T23:59:59Z'));
    expect(occurrences.map((o) => o.start.toISOString())).toEqual([
      '2026-07-04T08:00:00.000Z',
      '2026-08-04T08:00:00.000Z',
      '2026-09-04T08:00:00.000Z',
    ]);
  });

  it('mensuel : le 31 est ramené au dernier jour des mois plus courts', () => {
    const endOfMonth = range('2026-03-31T08:00:00Z', '2026-03-31T18:00:00Z');
    const occurrences = generateOccurrences(endOfMonth, 'MONTHLY', new Date('2026-05-31T23:59:59Z'));
    expect(occurrences.map((o) => o.start.getDate())).toEqual([31, 30, 31]);
    expect(occurrences.map((o) => o.start.getMonth())).toEqual([2, 3, 4]);
  });

  it('borne avant la première répétition : une seule occurrence', () => {
    const occurrences = generateOccurrences(base, 'WEEKLY', new Date('2026-07-05T00:00:00Z'));
    expect(occurrences).toHaveLength(1);
  });

  it('rejette une borne antérieure au début', () => {
    expect(() => generateOccurrences(base, 'WEEKLY', new Date('2026-07-01T00:00:00Z'))).toThrow(DomainError);
  });

  it('rejette une répétition dépassant la limite', () => {
    expect(() => generateOccurrences(base, 'WEEKLY', new Date('2028-07-04T00:00:00Z'))).toThrow(
      new RegExp(`${MAX_OCCURRENCES}`),
    );
  });
});
