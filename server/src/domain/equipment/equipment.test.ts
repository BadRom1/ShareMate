import { describe, expect, it } from 'vitest';
import { Money } from '../shared/money.js';
import { Equipment } from './equipment.js';

const base = {
  id: 'e1',
  name: 'Minipelle',
  category: 'BTP',
  acquisitionDate: new Date('2025-03-01'),
  purchaseValue: Money.fromEuros(15000),
  meterUnit: 'HOURS' as const,
  memberIds: ['m1', 'm2'],
  maintenanceThreshold: 50,
};

describe('Equipment', () => {
  it('se crée avec ses caractéristiques', () => {
    const e = Equipment.create(base);
    expect(e.name).toBe('Minipelle');
    expect(e.meterUnit).toBe('HOURS');
    expect(e.purchaseValue.toEuros()).toBe(15000);
    expect(e.memberIds).toEqual(['m1', 'm2']);
  });

  it('rejette un nom vide', () => {
    expect(() => Equipment.create({ ...base, name: '' })).toThrow();
  });

  it("rejette une valeur d'achat négative", () => {
    expect(() => Equipment.create({ ...base, purchaseValue: Money.fromEuros(-1) })).toThrow();
  });

  it('exige au moins un utilisateur dans le cercle', () => {
    expect(() => Equipment.create({ ...base, memberIds: [] })).toThrow();
  });

  it('dédoublonne les utilisateurs du cercle', () => {
    const e = Equipment.create({ ...base, memberIds: ['m1', 'm1'] });
    expect(e.memberIds).toEqual(['m1']);
  });

  it('rejette un seuil de maintenance négatif ou nul', () => {
    expect(() => Equipment.create({ ...base, maintenanceThreshold: 0 })).toThrow();
    expect(() => Equipment.create({ ...base, maintenanceThreshold: -5 })).toThrow();
  });

  it("accepte l'absence de seuil de maintenance", () => {
    const e = Equipment.create({ ...base, maintenanceThreshold: null });
    expect(e.maintenanceThreshold).toBeNull();
  });

  it("vérifie l'accès d'un membre", () => {
    const e = Equipment.create(base);
    expect(e.canBeUsedBy('m1')).toBe(true);
    expect(e.canBeUsedBy('m9')).toBe(false);
  });

  it('se met à jour de façon immuable', () => {
    const e = Equipment.create(base);
    const updated = e.update({ name: 'Minipelle 2T', maintenanceThreshold: 100 });
    expect(updated.name).toBe('Minipelle 2T');
    expect(updated.maintenanceThreshold).toBe(100);
    expect(e.name).toBe('Minipelle'); // original inchangé
  });
});
