import { describe, expect, it } from 'vitest';
import { Money } from '../shared/money.js';
import { Equipment } from '../equipment/equipment.js';
import { UsageRecord } from './usage-record.js';
import { computeMaintenanceStatus } from './maintenance-alert.js';

const equipment = (threshold: number | null) =>
  Equipment.create({
    id: 'e1',
    name: 'Minipelle',
    category: 'BTP',
    acquisitionDate: new Date('2025-01-01'),
    purchaseValue: Money.fromEuros(15000),
    meterUnit: 'HOURS',
    memberIds: ['m1'],
    maintenanceThreshold: threshold,
  });

const usage = (id: string, reading: number, isMaintenance = false) =>
  UsageRecord.create({
    id,
    equipmentId: 'e1',
    memberId: 'm1',
    recordedAt: new Date('2026-07-01T10:00Z'),
    meterReading: reading,
    isMaintenance,
  });

describe('computeMaintenanceStatus', () => {
  it("sans seuil configuré : pas d'alerte", () => {
    const s = computeMaintenanceStatus(equipment(null), [usage('u1', 100)]);
    expect(s.alert).toBe(false);
    expect(s.threshold).toBeNull();
  });

  it("sans aucun relevé : pas d'alerte, compteur inconnu", () => {
    const s = computeMaintenanceStatus(equipment(50), []);
    expect(s.alert).toBe(false);
    expect(s.currentReading).toBeNull();
  });

  it("sous le seuil depuis la dernière maintenance : pas d'alerte", () => {
    const records = [usage('u1', 100, true), usage('u2', 130)];
    const s = computeMaintenanceStatus(equipment(50), records);
    expect(s.alert).toBe(false);
    expect(s.unitsSinceMaintenance).toBe(30);
  });

  it('au-delà du seuil depuis la dernière maintenance : alerte', () => {
    const records = [usage('u1', 100, true), usage('u2', 155)];
    const s = computeMaintenanceStatus(equipment(50), records);
    expect(s.alert).toBe(true);
    expect(s.unitsSinceMaintenance).toBe(55);
  });

  it('alerte au seuil exact', () => {
    const records = [usage('u1', 100, true), usage('u2', 150)];
    const s = computeMaintenanceStatus(equipment(50), records);
    expect(s.alert).toBe(true);
  });

  it('sans maintenance déclarée : compte depuis le premier relevé', () => {
    const records = [usage('u1', 10), usage('u2', 70)];
    const s = computeMaintenanceStatus(equipment(50), records);
    expect(s.unitsSinceMaintenance).toBe(60);
    expect(s.alert).toBe(true);
  });

  it('utilise la dernière maintenance (relevé le plus haut marqué maintenance)', () => {
    const records = [usage('u1', 100, true), usage('u2', 160, true), usage('u3', 180)];
    const s = computeMaintenanceStatus(equipment(50), records);
    expect(s.unitsSinceMaintenance).toBe(20);
    expect(s.alert).toBe(false);
  });
});
