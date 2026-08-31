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

  it('rejette une date de relevé illisible', () => {
    expect(() => UsageRecord.create({ ...base, recordedAt: new Date('0000-00-00') })).toThrow();
  });

  it('rejette un carburant négatif', () => {
    expect(() => UsageRecord.create({ ...base, fuelAddedLiters: -2 })).toThrow();
  });

  it('accepte carburant et remarques absents', () => {
    const u = UsageRecord.create({ ...base, fuelAddedLiters: null, notes: null });
    expect(u.fuelAddedLiters).toBeNull();
    expect(u.notes).toBeNull();
  });

  it('porte le compteur relevé au départ', () => {
    const u = UsageRecord.create({ ...base, startReading: 116.25 });
    expect(u.startReading).toBe(116.25);
  });

  it('sans compteur au départ, le point de départ reste inconnu', () => {
    expect(UsageRecord.create(base).startReading).toBeNull();
  });

  it('rejette un départ au-delà de l’arrivée : un compteur ne recule pas', () => {
    expect(() => UsageRecord.create({ ...base, startReading: 130 })).toThrow(/départ/);
  });

  it('rejette un départ négatif', () => {
    expect(() => UsageRecord.create({ ...base, startReading: -1 })).toThrow();
  });

  it('accepte un relevé sans membre : segment constaté, en attente d’attribution', () => {
    expect(UsageRecord.create({ ...base, memberId: null }).memberId).toBeNull();
  });

  it('peut être une déclaration de maintenance', () => {
    const u = UsageRecord.create({ ...base, isMaintenance: true });
    expect(u.isMaintenance).toBe(true);
  });
});
