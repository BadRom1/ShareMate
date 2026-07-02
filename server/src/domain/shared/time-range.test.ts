import { describe, expect, it } from 'vitest';
import { TimeRange } from './time-range.js';

const d = (s: string) => new Date(s);

describe('TimeRange', () => {
  it('exige une fin strictement après le début', () => {
    expect(() => TimeRange.create(d('2026-07-02T10:00Z'), d('2026-07-02T09:00Z'))).toThrow();
    expect(() => TimeRange.create(d('2026-07-02T10:00Z'), d('2026-07-02T10:00Z'))).toThrow();
  });

  it('rejette les dates invalides', () => {
    expect(() => TimeRange.create(new Date('invalide'), d('2026-07-02T10:00Z'))).toThrow();
  });

  it('détecte le chevauchement de deux créneaux', () => {
    const a = TimeRange.create(d('2026-07-02T08:00Z'), d('2026-07-02T12:00Z'));
    const inside = TimeRange.create(d('2026-07-02T09:00Z'), d('2026-07-02T10:00Z'));
    const partial = TimeRange.create(d('2026-07-02T11:00Z'), d('2026-07-02T14:00Z'));
    const covering = TimeRange.create(d('2026-07-02T07:00Z'), d('2026-07-02T13:00Z'));
    expect(a.overlaps(inside)).toBe(true);
    expect(a.overlaps(partial)).toBe(true);
    expect(a.overlaps(covering)).toBe(true);
  });

  it('les créneaux adjacents ne se chevauchent pas (fin exclusive)', () => {
    const a = TimeRange.create(d('2026-07-02T08:00Z'), d('2026-07-02T12:00Z'));
    const after = TimeRange.create(d('2026-07-02T12:00Z'), d('2026-07-02T14:00Z'));
    const before = TimeRange.create(d('2026-07-02T06:00Z'), d('2026-07-02T08:00Z'));
    expect(a.overlaps(after)).toBe(false);
    expect(a.overlaps(before)).toBe(false);
  });

  it('calcule la durée en heures', () => {
    const a = TimeRange.create(d('2026-07-02T08:00Z'), d('2026-07-02T12:30Z'));
    expect(a.durationHours()).toBe(4.5);
  });
});
