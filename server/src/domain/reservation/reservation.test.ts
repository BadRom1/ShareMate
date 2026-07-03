import { describe, expect, it } from 'vitest';
import { TimeRange } from '../shared/time-range.js';
import { Reservation } from './reservation.js';
import type { ReservationStatus } from './reservation.js';
import { conflictMap, findConflicts, hasPriorityOver } from './reservation-conflict.js';

const d = (s: string) => new Date(s);
const range = (start: string, end: string) => TimeRange.create(d(start), d(end));

const make = (
  id: string,
  equipmentId: string,
  start: string,
  end: string,
  memberId = 'm1',
  status: ReservationStatus = 'REQUIRED',
  createdAt = '2026-07-01T00:00Z',
) => Reservation.create({ id, equipmentId, memberId, range: range(start, end), status, createdAt: d(createdAt) });

describe('Reservation', () => {
  it('se crée avec un créneau valide', () => {
    const r = make('r1', 'e1', '2026-07-02T08:00Z', '2026-07-02T12:00Z');
    expect(r.equipmentId).toBe('e1');
    expect(r.range.durationHours()).toBe(4);
  });

  it('est obligatoire (REQUIRED) par défaut', () => {
    const r = Reservation.create({
      id: 'r1',
      equipmentId: 'e1',
      memberId: 'm1',
      range: range('2026-07-02T08:00Z', '2026-07-02T12:00Z'),
    });
    expect(r.status).toBe('REQUIRED');
  });
});

describe('findConflicts', () => {
  const existing = [
    make('r1', 'e1', '2026-07-02T08:00Z', '2026-07-02T12:00Z'),
    make('r2', 'e1', '2026-07-03T08:00Z', '2026-07-03T12:00Z'),
  ];

  it('aucun conflit sur un créneau libre du même équipement', () => {
    const candidate = make('r3', 'e1', '2026-07-02T12:00Z', '2026-07-02T14:00Z', 'm2');
    expect(findConflicts(candidate, existing)).toHaveLength(0);
  });

  it('signale un créneau chevauchant sur le même équipement', () => {
    const candidate = make('r3', 'e1', '2026-07-02T10:00Z', '2026-07-02T14:00Z', 'm2');
    expect(findConflicts(candidate, existing).map((r) => r.id)).toEqual(['r1']);
  });

  it('un chevauchement sur un autre équipement n\'est pas un conflit', () => {
    const candidate = make('r3', 'e2', '2026-07-02T10:00Z', '2026-07-02T14:00Z', 'm2');
    expect(findConflicts(candidate, existing)).toHaveLength(0);
  });

  it('ignore la réservation elle-même (cas de modification)', () => {
    const modified = make('r1', 'e1', '2026-07-02T09:00Z', '2026-07-02T13:00Z');
    expect(findConflicts(modified, existing)).toHaveLength(0);
  });
});

describe('hasPriorityOver', () => {
  it('une réservation obligatoire prime sur un prévisionnel, même plus récent', () => {
    const planned = make('r1', 'e1', '2026-07-02T08:00Z', '2026-07-02T12:00Z', 'm1', 'PLANNED', '2026-06-01T00:00Z');
    const required = make('r2', 'e1', '2026-07-02T10:00Z', '2026-07-02T14:00Z', 'm2', 'REQUIRED', '2026-06-15T00:00Z');
    expect(hasPriorityOver(required, planned)).toBe(true);
    expect(hasPriorityOver(planned, required)).toBe(false);
  });

  it('à statut égal, le premier créé a la priorité', () => {
    const first = make('r1', 'e1', '2026-07-02T08:00Z', '2026-07-02T12:00Z', 'm1', 'REQUIRED', '2026-06-01T00:00Z');
    const second = make('r2', 'e1', '2026-07-02T10:00Z', '2026-07-02T14:00Z', 'm2', 'REQUIRED', '2026-06-15T00:00Z');
    expect(hasPriorityOver(first, second)).toBe(true);
    expect(hasPriorityOver(second, first)).toBe(false);
  });
});

describe('conflictMap', () => {
  it('annote chaque réservation avec les ids en conflit', () => {
    const list = [
      make('r1', 'e1', '2026-07-02T08:00Z', '2026-07-02T12:00Z'),
      make('r2', 'e1', '2026-07-02T10:00Z', '2026-07-02T14:00Z', 'm2'),
      make('r3', 'e1', '2026-07-03T08:00Z', '2026-07-03T12:00Z'),
    ];
    const map = conflictMap(list);
    expect(map.get('r1')).toEqual(['r2']);
    expect(map.get('r2')).toEqual(['r1']);
    expect(map.get('r3')).toEqual([]);
  });
});
