import { beforeEach, describe, expect, it } from 'vitest';
import { makeFixture } from './testing/fixture.js';
import { EquipmentService } from './equipment-service.js';

let f: Awaited<ReturnType<typeof makeFixture>>;
let service: EquipmentService;

beforeEach(async () => {
  f = await makeFixture();
  service = new EquipmentService(f.equipments, f.groups, f.idGenerator);
});

describe('EquipmentService', () => {
  it('crée un équipement pour un groupe', async () => {
    const created = await service.create({
      groupId: 'g1',
      name: 'Remorque',
      category: 'Transport',
      acquisitionDate: '2026-01-15',
      purchaseValueEuros: 1200,
      meterUnit: 'KILOMETERS',
      accessMemberIds: ['m1', 'm3'],
      maintenanceThreshold: 5000,
    });
    expect(created.id).toBeTruthy();
    const found = await f.equipments.findById(created.id);
    expect(found?.name).toBe('Remorque');
    expect(found?.meterUnit).toBe('KILOMETERS');
  });

  it('refuse un groupe inexistant', async () => {
    await expect(
      service.create({
        groupId: 'inconnu',
        name: 'X',
        category: 'C',
        acquisitionDate: '2026-01-15',
        purchaseValueEuros: 10,
        meterUnit: 'HOURS',
        accessMemberIds: ['m1'],
        maintenanceThreshold: null,
      }),
    ).rejects.toThrow(/groupe/i);
  });

  it('refuse un membre d\'accès hors du groupe', async () => {
    await expect(
      service.create({
        groupId: 'g1',
        name: 'X',
        category: 'C',
        acquisitionDate: '2026-01-15',
        purchaseValueEuros: 10,
        meterUnit: 'HOURS',
        accessMemberIds: ['m1', 'etranger'],
        maintenanceThreshold: null,
      }),
    ).rejects.toThrow(/membre/i);
  });

  it('met à jour un équipement', async () => {
    const updated = await service.update('e1', { name: 'Minipelle 2T', maintenanceThreshold: 100 });
    expect(updated.name).toBe('Minipelle 2T');
    expect(updated.maintenanceThreshold).toBe(100);
  });

  it('échoue à mettre à jour un équipement inexistant', async () => {
    await expect(service.update('nope', { name: 'X' })).rejects.toThrow(/introuvable/i);
  });

  it('supprime un équipement', async () => {
    await service.delete('e1');
    expect(await f.equipments.findById('e1')).toBeNull();
  });

  it('liste les équipements d\'un groupe', async () => {
    const list = await service.listByGroup('g1');
    expect(list.map((e) => e.id)).toEqual(['e1']);
  });
});
