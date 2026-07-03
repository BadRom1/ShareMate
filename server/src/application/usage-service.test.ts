import { beforeEach, describe, expect, it } from 'vitest';
import { makeFixture } from './testing/fixture.js';
import { UsageService } from './usage-service.js';

let f: Awaited<ReturnType<typeof makeFixture>>;
let service: UsageService;

beforeEach(async () => {
  f = await makeFixture();
  service = new UsageService(f.usageRecords, f.equipments, f.idGenerator, f.clock);
});

const input = {
  equipmentId: 'e1',
  memberId: 'm1',
  meterReading: 120,
  fuelAddedLiters: 10,
  notes: 'RAS',
};

describe('UsageService', () => {
  it('enregistre un relevé de fin d\'utilisation', async () => {
    const u = await service.recordUsage(input);
    expect(u.meterReading).toBe(120);
    expect(u.recordedAt.toISOString()).toBe('2026-07-02T10:00:00.000Z');
  });

  it('refuse un membre sans accès', async () => {
    await expect(service.recordUsage({ ...input, memberId: 'm3' })).rejects.toThrow(/accès/i);
  });

  it('refuse un relevé inférieur au dernier compteur connu', async () => {
    await service.recordUsage(input);
    await expect(service.recordUsage({ ...input, meterReading: 100 })).rejects.toThrow(/compteur/i);
  });

  it('historique par équipement, trié du plus récent au plus ancien', async () => {
    await service.recordUsage({ ...input, meterReading: 100 });
    f.clock.set(new Date('2026-07-03T10:00:00Z'));
    await service.recordUsage({ ...input, memberId: 'm2', meterReading: 110 });
    const history = await service.historyByEquipment('e1');
    expect(history.map((u) => u.meterReading)).toEqual([110, 100]);
  });

  it('historique par membre', async () => {
    await service.recordUsage(input);
    const history = await service.historyByMember('m1');
    expect(history).toHaveLength(1);
    expect(history[0]!.memberId).toBe('m1');
  });

  it('statut de maintenance : alerte au-delà du seuil (50 h)', async () => {
    await service.recordUsage({ ...input, meterReading: 100, isMaintenance: true });
    await service.recordUsage({ ...input, meterReading: 160 });
    const status = await service.maintenanceStatus('e1');
    expect(status.alert).toBe(true);
    expect(status.unitsSinceMaintenance).toBe(60);
  });

  it('alertes globales : uniquement les équipements en alerte', async () => {
    await service.recordUsage({ ...input, meterReading: 100, isMaintenance: true });
    await service.recordUsage({ ...input, meterReading: 130 });
    expect(await service.alerts()).toHaveLength(0);

    await service.recordUsage({ ...input, meterReading: 155 });
    const alerts = await service.alerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.equipmentId).toBe('e1');
  });
});
