import { beforeEach, describe, expect, it } from 'vitest';
import { makeFixture } from './testing/fixture.js';
import { EquipmentService } from './equipment-service.js';
import { ForbiddenError } from '../domain/shared/domain-error.js';
import { Expense } from '../domain/expense/expense.js';
import { Money } from '../domain/shared/money.js';

let f: Awaited<ReturnType<typeof makeFixture>>;
let service: EquipmentService;

beforeEach(async () => {
  f = await makeFixture();
  service = new EquipmentService(f.equipments, f.members, f.idGenerator, f.expenses, f.receipts);
});

describe('EquipmentService', () => {
  it("crée un équipement avec son cercle d'utilisateurs", async () => {
    const created = await service.create(
      {
        name: 'Remorque',
        category: 'Transport',
        acquisitionDate: '2026-01-15',
        purchaseValueEuros: 1200,
        meterUnit: 'KILOMETERS',
        memberIds: ['m1', 'm3'],
        maintenanceThreshold: 5000,
      },
      'm1',
    );
    expect(created.id).toBeTruthy();
    const found = await f.equipments.findById(created.id);
    expect(found?.name).toBe('Remorque');
    expect(found?.meterUnit).toBe('KILOMETERS');
    expect(found?.memberIds).toEqual(['m1', 'm3']);
  });

  it('refuse un membre inconnu dans le cercle', async () => {
    await expect(
      service.create(
        {
          name: 'X',
          category: 'C',
          acquisitionDate: '2026-01-15',
          purchaseValueEuros: 10,
          meterUnit: 'HOURS',
          memberIds: ['m1', 'etranger'],
          maintenanceThreshold: null,
        },
        'm1',
      ),
    ).rejects.toThrow(/membre/i);
  });

  it('refuse un créateur absent du cercle : il ne verrait pas son propre équipement', async () => {
    await expect(
      service.create(
        {
          name: 'X',
          category: 'C',
          acquisitionDate: '2026-01-15',
          purchaseValueEuros: 10,
          meterUnit: 'HOURS',
          memberIds: ['m2'],
          maintenanceThreshold: null,
        },
        'm1',
      ),
    ).rejects.toThrow(/cercle/i);
  });

  it('met à jour un équipement', async () => {
    const updated = await service.update('e1', { name: 'Minipelle 2T', maintenanceThreshold: 100 }, 'm1');
    expect(updated.name).toBe('Minipelle 2T');
    expect(updated.maintenanceThreshold).toBe(100);
  });

  it("met à jour le cercle d'un équipement", async () => {
    const updated = await service.update('e1', { memberIds: ['m1', 'm2', 'm3'] }, 'm1');
    expect(updated.memberIds).toEqual(['m1', 'm2', 'm3']);
  });

  it('refuse un cercle contenant un membre inconnu à la mise à jour', async () => {
    await expect(service.update('e1', { memberIds: ['m1', 'fantome'] }, 'm1')).rejects.toThrow(/membre/i);
  });

  it('échoue à mettre à jour un équipement inexistant', async () => {
    await expect(service.update('nope', { name: 'X' }, 'm1')).rejects.toThrow(/introuvable/i);
  });

  it('supprime un équipement', async () => {
    await service.delete('e1', 'm1');
    expect(await f.equipments.findById('e1')).toBeNull();
  });

  it('purge les justificatifs des dépenses emportées par la suppression', async () => {
    const receiptPath = '/uploads/8f14e45f-ceea-467a-a3f6-9b1f3e2c7d40.png';
    f.receipts.add(receiptPath);
    await f.expenses.save(
      Expense.create({
        id: 'x1',
        equipmentId: 'e1',
        label: 'Plein gasoil',
        amount: Money.fromEuros(90),
        payerId: 'm1',
        date: new Date('2026-07-01'),
        category: 'FUEL',
        split: { type: 'EQUAL', memberIds: ['m1', 'm2'] },
        receiptPath,
      }),
    );
    await service.delete('e1', 'm1');
    // La cascade de la persistance efface les dépenses ; le fichier, lui, n'est atteint que d'ici.
    expect(f.receipts.paths.has(receiptPath)).toBe(false);
  });

  it('ne liste que les équipements du cercle du demandeur', async () => {
    expect((await service.list('m1')).map((e) => e.id)).toEqual(['e1']);
    // m3 ne partage pas la minipelle : pour lui, elle n'existe pas.
    expect(await service.list('m3')).toEqual([]);
  });

  it('refuse lecture, modification et suppression à un membre hors du cercle', async () => {
    await expect(service.getById('e1', 'm3')).rejects.toThrow(ForbiddenError);
    await expect(service.update('e1', { name: 'Pirate' }, 'm3')).rejects.toThrow(ForbiddenError);
    await expect(service.delete('e1', 'm3')).rejects.toThrow(ForbiddenError);
    expect(await f.equipments.findById('e1')).not.toBeNull();
  });
});
