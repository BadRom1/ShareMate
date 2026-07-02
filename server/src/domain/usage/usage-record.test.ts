import { describe, expect, it } from 'vitest';
import { UsageRecord } from './usage-record.js';

const base = {
  id: 'u1',
  equipmentId: 'e1',
  memberId: 'm1',
  recordedAt: new Date('2026-07-02T12:00Z'),
  meterReading: 120.5,
  fuelAddedLiters: 15,
  notes: 'RAS',
  isMaintenance: false,
};

describe('UsageRecord', () => {
  it('se crée avec un relevé de compteur', () => {
    const u = UsageRecord.create(base);
    expect(u.meterReading).toBe(120.5);
    expect(u.fuelAddedLiters).toBe(15);
  });

  it('rejette un relevé négatif', () => {
    expect(() => UsageRecord.create({ ...base, meterReading: -1 })).toThrow();
  });

  it('rejette un carburant négatif', () => {
    expect(() => UsageRecord.create({ ...base, fuelAddedLiters: -2 })).toThrow();
  });

  it('accepte carburant et remarques absents', () => {
    const u = UsageRecord.create({ ...base, fuelAddedLiters: null, notes: null });
    expect(u.fuelAddedLiters).toBeNull();
    expect(u.notes).toBeNull();
  });

  it('peut être une déclaration de maintenance', () => {
    const u = UsageRecord.create({ ...base, isMaintenance: true });
    expect(u.isMaintenance).toBe(true);
  });
});
