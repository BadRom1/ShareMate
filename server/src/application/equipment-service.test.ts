import { beforeEach, describe, expect, it } from 'vitest';
import { makeFixture } from './testing/fixture.js';
import { EquipmentService } from './equipment-service.js';

let f: Awaited<ReturnType<typeof makeFixture>>;
let service: EquipmentService;

beforeEach(async () => {
  f = await makeFixture();
  service = new EquipmentService(f.equipments, f.members, f.idGenerator);
});

describe('EquipmentService', () => {
  it('crée un équipement avec son cercle d\'utilisateurs', async () => {
    const created = await service.create({
      name: 'Remorque',
      category: 'Transport',
      acquisitionDate: '2026-01-15',
      purchaseValueEuros: 1200,
      meterUnit: 'KILOMETERS',
      memberIds: ['m1', 'm3'],
      maintenanceThreshold: 5000,
    });
    expect(created.id).toBeTruthy();
    const found = await f.equipments.findById(created.id);
    expect(found?.name).toBe('Remorque');
    expect(found?.meterUnit).toBe('KILOMETERS');
    expect(found?.memberIds).toEqual(['m1', 'm3']);
  });

  it('refuse un membre inconnu dans le cercle', async () => {
    await expect(
      service.create({
        name: 'X',
        category: 'C',
        acquisitionDate: '2026-01-15',
        purchaseValueEuros: 10,
        meterUnit: 'HOURS',
        memberIds: ['m1', 'etranger'],
        maintenanceThreshold: null,
      }),
    ).rejects.toThrow(/membre/i);
  });

  it('met à jour un équipement', async () => {
    const updated = await service.update('e1', { name: 'Minipelle 2T', maintenanceThreshold: 100 });
    expect(updated.name).toBe('Minipelle 2T');
    expect(updated.maintenanceThreshold).toBe(100);
  });

  it('met à jour le cercle d\'un équipement', async () => {
    const updated = await service.update('e1', { memberIds: ['m1', 'm2', 'm3'] });
    expect(updated.memberIds).toEqual(['m1', 'm2', 'm3']);
  });

  it('refuse un cercle contenant un membre inconnu à la mise à jour', async () => {
    await expect(service.update('e1', { memberIds: ['m1', 'fantome'] })).rejects.toThrow(/membre/i);
  });

  it('échoue à mettre à jour un équipement inexistant', async () => {
    await expect(service.update('nope', { name: 'X' })).rejects.toThrow(/introuvable/i);
  });

  it('supprime un équipement', async () => {
    await service.delete('e1');
    expect(await f.equipments.findById('e1')).toBeNull();
  });

  it('liste tous les équipements', async () => {
    const list = await service.list();
    expect(list.map((e) => e.id)).toEqual(['e1']);
  });
});
