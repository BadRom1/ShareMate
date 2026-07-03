import { describe, expect, it } from 'vitest';
import { TimeRange } from '../shared/time-range.js';
import { Reservation } from './reservation.js';
import { assertNoConflict } from './reservation-conflict.js';
import { ConflictError } from '../shared/domain-error.js';

const d = (s: string) => new Date(s);
const range = (start: string, end: string) => TimeRange.create(d(start), d(end));

const make = (id: string, equipmentId: string, start: string, end: string, memberId = 'm1') =>
  Reservation.create({ id, equipmentId, memberId, range: range(start, end) });

describe('Reservation', () => {
  it('se crée avec un créneau valide', () => {
    const r = make('r1', 'e1', '2026-07-02T08:00Z', '2026-07-02T12:00Z');
    expect(r.equipmentId).toBe('e1');
    expect(r.range.durationHours()).toBe(4);
  });
});

describe('assertNoConflict', () => {
  const existing = [
    make('r1', 'e1', '2026-07-02T08:00Z', '2026-07-02T12:00Z'),
    make('r2', 'e1', '2026-07-03T08:00Z', '2026-07-03T12:00Z'),
  ];

  it('accepte un créneau libre sur le même équipement', () => {
    const candidate = make('r3', 'e1', '2026-07-02T12:00Z', '2026-07-02T14:00Z', 'm2');
    expect(() => assertNoConflict(candidate, existing)).not.toThrow();
  });

  it('rejette un créneau chevauchant sur le même équipement', () => {
    const candidate = make('r3', 'e1', '2026-07-02T10:00Z', '2026-07-02T14:00Z', 'm2');
    expect(() => assertNoConflict(candidate, existing)).toThrow(ConflictError);
  });

  it('même le réservataire initial ne peut pas doubler son créneau', () => {
    const candidate = make('r3', 'e1', '2026-07-02T09:00Z', '2026-07-02T10:00Z', 'm1');
    expect(() => assertNoConflict(candidate, existing)).toThrow(ConflictError);
  });

  it('un chevauchement sur un autre équipement n\'est pas un conflit', () => {
    const candidate = make('r3', 'e2', '2026-07-02T10:00Z', '2026-07-02T14:00Z', 'm2');
    expect(() => assertNoConflict(candidate, existing)).not.toThrow();
  });

  it('ignore la réservation elle-même (cas de modification)', () => {
    const modified = make('r1', 'e1', '2026-07-02T09:00Z', '2026-07-02T13:00Z');
    expect(() => assertNoConflict(modified, existing)).not.toThrow();
  });
});
