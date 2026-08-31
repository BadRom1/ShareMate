import { beforeEach, describe, expect, it } from 'vitest';
import { makeFixture } from './testing/fixture.js';
import { UsageService } from './usage-service.js';
import { ForbiddenError, NotFoundError } from '../domain/shared/domain-error.js';
import { CapturingNotifier, NullNotifier } from './testing/in-memory.js';

let f: Awaited<ReturnType<typeof makeFixture>>;
let service: UsageService;

beforeEach(async () => {
  f = await makeFixture();
  service = new UsageService(f.usageRecords, f.equipments, f.idGenerator, f.clock, new NullNotifier());
});

const input = {
  equipmentId: 'e1',
  memberId: 'm1',
  meterReading: 120,
  fuelAddedLiters: 10,
  notes: 'RAS',
};

describe('UsageService', () => {
  it("enregistre un relevé de fin d'utilisation", async () => {
    const { record, duration } = await service.recordUsage(input);
    expect(record.meterReading).toBe(120);
    expect(record.recordedAt.toISOString()).toBe('2026-07-02T10:00:00.000Z');
    expect(duration).toBeNull();
  });

  it('attribue au membre la durée écoulée depuis le dernier relevé', async () => {
    await service.recordUsage({ ...input, meterReading: 100 });
    const { record, duration } = await service.recordUsage({ ...input, memberId: 'm2', meterReading: 112.5 });
    expect(record.memberId).toBe('m2');
    expect(duration).toBe(12.5);
  });

  it('enregistre par durée : le compteur est calculé depuis le dernier relevé connu', async () => {
    await service.recordUsage({ ...input, meterReading: 100 });
    const { record, duration } = await service.recordUsage({
      equipmentId: 'e1',
      memberId: 'm2',
      duration: 3.5,
    });
    expect(record.meterReading).toBe(103.5);
    expect(duration).toBe(3.5);
  });

  it('une durée à décimale ne laisse pas filtrer le bruit flottant', async () => {
    await service.recordUsage({ ...input, meterReading: 164 });
    const { record, duration } = await service.recordUsage({ equipmentId: 'e1', memberId: 'm2', duration: 1.3 });
    expect(record.meterReading).toBe(165.3);
    expect(duration).toBe(1.3);

    const history = await service.historyByEquipment('e1', 'm1');
    expect(history.find((e) => e.record.id === record.id)!.duration).toBe(1.3);
  });

  it('refuse une durée sans relevé précédent (compteur de départ inconnu)', async () => {
    await expect(service.recordUsage({ equipmentId: 'e1', memberId: 'm1', duration: 3 })).rejects.toThrow(
      /relevé précédent/i,
    );
  });

  it('refuse une durée négative', async () => {
    await service.recordUsage(input);
    await expect(service.recordUsage({ equipmentId: 'e1', memberId: 'm1', duration: -2 })).rejects.toThrow(/durée/i);
  });

  it('refuse un enregistrement sans compteur ni durée', async () => {
    await expect(service.recordUsage({ equipmentId: 'e1', memberId: 'm1' })).rejects.toThrow(/compteur ou la durée/i);
  });

  it('refuse un membre hors du cercle', async () => {
    await expect(service.recordUsage({ ...input, memberId: 'm3' })).rejects.toThrow(ForbiddenError);
  });

  it('refuse un relevé inférieur au dernier compteur connu', async () => {
    await service.recordUsage(input);
    await expect(service.recordUsage({ ...input, meterReading: 100 })).rejects.toThrow(/compteur/i);
  });

  it('historique par équipement, trié du plus récent au plus ancien, avec durées', async () => {
    await service.recordUsage({ ...input, meterReading: 100 });
    f.clock.set(new Date('2026-07-03T10:00:00Z'));
    await service.recordUsage({ ...input, memberId: 'm2', meterReading: 110 });
    const history = await service.historyByEquipment('e1', 'm1');
    expect(history.map((e) => e.record.meterReading)).toEqual([110, 100]);
    expect(history.map((e) => e.duration)).toEqual([10, null]);
  });

  it("historique par membre : durée calculée sur l'historique complet de l'équipement", async () => {
    await service.recordUsage({ ...input, memberId: 'm1', meterReading: 100 });
    f.clock.set(new Date('2026-07-03T10:00:00Z'));
    await service.recordUsage({ ...input, memberId: 'm2', meterReading: 108 });
    const history = await service.historyByMember('m2', 'm1');
    expect(history).toHaveLength(1);
    expect(history[0]!.record.memberId).toBe('m2');
    expect(history[0]!.duration).toBe(8);
  });

  it('statut de maintenance : alerte au-delà du seuil (50 h)', async () => {
    await service.recordUsage({ ...input, meterReading: 100, isMaintenance: true });
    await service.recordUsage({ ...input, meterReading: 160 });
    const status = await service.maintenanceStatus('e1', 'm1');
    expect(status.alert).toBe(true);
    expect(status.unitsSinceMaintenance).toBe(60);
  });

  it('refuse tout accès à un membre hors du cercle (historiques, statut, alertes)', async () => {
    await service.recordUsage({ ...input, meterReading: 100, isMaintenance: true });
    await service.recordUsage({ ...input, meterReading: 200 });
    await expect(service.historyByEquipment('e1', 'm3')).rejects.toThrow(ForbiddenError);
    await expect(service.maintenanceStatus('e1', 'm3')).rejects.toThrow(ForbiddenError);
    // Vues globales : filtrées, pas d'erreur mais rien à voir.
    expect(await service.alerts('m3')).toHaveLength(0);
    expect(await service.historyByMember('m1', 'm3')).toHaveLength(0);
  });

  it('alertes globales : uniquement les équipements en alerte', async () => {
    await service.recordUsage({ ...input, meterReading: 100, isMaintenance: true });
    await service.recordUsage({ ...input, meterReading: 130 });
    expect(await service.alerts('m1')).toHaveLength(0);

    await service.recordUsage({ ...input, meterReading: 155 });
    const alerts = await service.alerts('m1');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.equipmentId).toBe('e1');
  });
});

/**
 * Le compteur trouvé au départ borne la durée du relevé. Tant qu'il valait implicitement « le
 * dernier relevé connu », les heures d'un membre qui oubliait sa saisie tombaient sur le suivant.
 */
describe('UsageService — compteur au départ', () => {
  it('la durée se compte depuis le départ déclaré, pas depuis le dernier relevé', async () => {
    await service.recordUsage({ ...input, meterReading: 100 });
    const { record, duration } = await service.recordUsage({
      ...input,
      memberId: 'm2',
      startReading: 158,
      meterReading: 165,
    });
    expect(duration).toBe(7);
    expect(record.startReading).toBe(158);
  });

  it('par durée : le compteur se calcule depuis le départ déclaré', async () => {
    await service.recordUsage({ ...input, meterReading: 100 });
    const { record } = await service.recordUsage({ equipmentId: 'e1', memberId: 'm2', startReading: 158, duration: 7 });
    expect(record.meterReading).toBe(165);
  });

  it('refuse un départ sous le dernier relevé connu', async () => {
    await service.recordUsage({ ...input, meterReading: 100 });
    await expect(service.recordUsage({ ...input, startReading: 90, meterReading: 120 })).rejects.toThrow(/départ/);
  });

  it("sans départ déclaré, le dernier relevé fait foi : rien ne change pour qui n'y touche pas", async () => {
    await service.recordUsage({ ...input, meterReading: 100 });
    const { record, duration, gap } = await service.recordUsage({ ...input, memberId: 'm2', meterReading: 112 });
    expect(duration).toBe(12);
    expect(record.startReading).toBe(100);
    expect(gap).toBeNull();
  });
});

/**
 * Le trou : entre le dernier relevé et le compteur trouvé au départ, l'engin a tourné pour
 * quelqu'un. Ces heures deviennent un relevé à part, jamais celles de qui les constate.
 */
describe('UsageService — segment en attente d’attribution', () => {
  it('ouvre un segment sans membre entre le dernier relevé et le départ', async () => {
    await service.recordUsage({ ...input, meterReading: 100 });
    f.clock.set(new Date('2026-07-03T10:00:00Z'));
    const { duration, gap } = await service.recordUsage({
      ...input,
      memberId: 'm2',
      startReading: 158,
      meterReading: 165,
    });
    expect(gap).not.toBeNull();
    expect(gap!.record.memberId).toBeNull();
    expect(gap!.duration).toBe(58);
    // Les 58 h constatées ne sont pas tombées sur celui qui les a déclarées.
    expect(duration).toBe(7);

    const history = await service.historyByEquipment('e1', 'm1');
    expect(history.map((e) => [e.record.memberId, e.duration])).toEqual([
      ['m2', 7],
      [null, 58],
      ['m1', null],
    ]);
  });

  it('attribue le segment au membre désigné par celui qui le constate', async () => {
    await service.recordUsage({ ...input, meterReading: 100 });
    f.clock.set(new Date('2026-07-03T10:00:00Z'));
    const { gap } = await service.recordUsage({
      ...input,
      memberId: 'm2',
      startReading: 158,
      meterReading: 165,
      gapMemberId: 'm1',
    });
    expect(gap!.record.memberId).toBe('m1');
    expect((await service.historyByMember('m1', 'm1')).map((e) => e.duration)).toEqual([58, null]);
  });

  it('refuse d’attribuer le segment hors du cercle', async () => {
    await service.recordUsage({ ...input, meterReading: 100 });
    await expect(
      service.recordUsage({ ...input, startReading: 158, meterReading: 165, gapMemberId: 'm3' }),
    ).rejects.toThrow(/cercle/);
  });

  it('un segment en attente n’apparaît dans l’historique de personne', async () => {
    await service.recordUsage({ ...input, meterReading: 100 });
    await service.recordUsage({ ...input, memberId: 'm2', startReading: 158, meterReading: 165 });
    expect((await service.historyByMember('m1', 'm1')).map((e) => e.record.meterReading)).toEqual([100]);
    expect((await service.historyByMember('m2', 'm1')).map((e) => e.record.meterReading)).toEqual([165]);
  });

  it('le premier relevé d’un équipement n’ouvre pas de segment', async () => {
    const { gap } = await service.recordUsage({ ...input, startReading: 158, meterReading: 165 });
    expect(gap).toBeNull();
  });
});

describe('UsageService — correction et suppression', () => {
  it('corrige le compteur, le carburant et les remarques', async () => {
    const { record } = await service.recordUsage({ ...input, meterReading: 120 });
    const { record: corrigé, duration } = await service.updateUsage(
      record.id,
      { meterReading: 130, startReading: 125, fuelAddedLiters: null, notes: 'Plein fait' },
      'm1',
    );
    expect(corrigé.meterReading).toBe(130);
    expect(corrigé.fuelAddedLiters).toBeNull();
    expect(corrigé.notes).toBe('Plein fait');
    expect(duration).toBe(5);
  });

  it('réattribue un relevé à un autre membre du cercle', async () => {
    const { record } = await service.recordUsage({ ...input, meterReading: 120 });
    const { record: corrigé } = await service.updateUsage(record.id, { memberId: 'm2' }, 'm2');
    expect(corrigé.memberId).toBe('m2');
    expect(await service.historyByMember('m1', 'm1')).toHaveLength(0);
  });

  it('attribue un segment en attente, et sait l’y remettre', async () => {
    await service.recordUsage({ ...input, meterReading: 100 });
    const { gap } = await service.recordUsage({ ...input, memberId: 'm2', startReading: 158, meterReading: 165 });
    const attribué = await service.updateUsage(gap!.record.id, { memberId: 'm1' }, 'm2');
    expect(attribué.record.memberId).toBe('m1');
    expect(attribué.duration).toBe(58);

    const rendu = await service.updateUsage(gap!.record.id, { memberId: null }, 'm1');
    expect(rendu.record.memberId).toBeNull();
  });

  it('refuse d’attribuer un relevé hors du cercle', async () => {
    const { record } = await service.recordUsage({ ...input, meterReading: 120 });
    await expect(service.updateUsage(record.id, { memberId: 'm3' }, 'm1')).rejects.toThrow(/cercle/);
  });

  it('un relevé se corrige, il ne se déplace pas dans la chaîne', async () => {
    const { record: premier } = await service.recordUsage({ ...input, meterReading: 100 });
    const { record: milieu } = await service.recordUsage({ ...input, meterReading: 150 });
    await service.recordUsage({ ...input, meterReading: 200 });

    await expect(service.updateUsage(milieu.id, { meterReading: 90 }, 'm1')).rejects.toThrow(/précédent/);
    await expect(service.updateUsage(milieu.id, { meterReading: 210 }, 'm1')).rejects.toThrow(/suivant/);
    // Le premier n'a pas de voisin en dessous : il descend librement.
    expect((await service.updateUsage(premier.id, { meterReading: 10 }, 'm1')).record.meterReading).toBe(10);
  });

  it('supprime un relevé du milieu : ses heures restent, en attente', async () => {
    await service.recordUsage({ ...input, meterReading: 100 });
    f.clock.set(new Date('2026-07-03T10:00:00Z'));
    const { record: milieu } = await service.recordUsage({ ...input, memberId: 'm2', meterReading: 150 });
    f.clock.set(new Date('2026-07-04T10:00:00Z'));
    await service.recordUsage({ ...input, meterReading: 200 });

    const rendu = await service.deleteUsage(milieu.id, 'm1');
    expect(rendu!.duration).toBe(50);
    const history = await service.historyByEquipment('e1', 'm1');
    // Le compteur est intact, et les 50 h du relevé supprimé n'ont sauté sur personne.
    expect(history.map((e) => [e.record.memberId, e.duration])).toEqual([
      ['m1', 50],
      [null, 50],
      ['m1', null],
    ]);
    expect((await service.maintenanceStatus('e1', 'm1')).currentReading).toBe(200);
    expect(await service.historyByMember('m2', 'm1')).toHaveLength(0);
  });

  it('supprime le dernier relevé : rien ne l’atteste plus, il disparaît', async () => {
    await service.recordUsage({ ...input, meterReading: 100 });
    f.clock.set(new Date('2026-07-03T10:00:00Z'));
    const { record: dernier } = await service.recordUsage({ ...input, meterReading: 150 });

    expect(await service.deleteUsage(dernier.id, 'm1')).toBeNull();
    expect(await service.historyByEquipment('e1', 'm1')).toHaveLength(1);
    expect((await service.maintenanceStatus('e1', 'm1')).currentReading).toBe(100);
  });

  it('refuse de supprimer un segment en attente que le compteur atteste', async () => {
    await service.recordUsage({ ...input, meterReading: 100 });
    f.clock.set(new Date('2026-07-03T10:00:00Z'));
    const { gap } = await service.recordUsage({ ...input, memberId: 'm2', startReading: 158, meterReading: 165 });

    // Le supprimer puis le recréer à l'identique ferait passer un refus pour un succès.
    await expect(service.deleteUsage(gap!.record.id, 'm1')).rejects.toThrow(/attestées/);
    expect(await service.historyByEquipment('e1', 'm1')).toHaveLength(3);
  });

  it('une saisie refusée ne laisse pas derrière elle le segment qu’elle allait ouvrir', async () => {
    await service.recordUsage({ ...input, meterReading: 100 });
    await expect(
      service.recordUsage({ ...input, startReading: 158, meterReading: 165, fuelAddedLiters: -5 }),
    ).rejects.toThrow(/carburant/i);
    expect(await service.historyByEquipment('e1', 'm1')).toHaveLength(1);
  });

  it('reculer le départ d’un relevé remet les heures rendues en attente', async () => {
    await service.recordUsage({ ...input, meterReading: 100 });
    f.clock.set(new Date('2026-07-03T10:00:00Z'));
    const { record } = await service.recordUsage({ ...input, memberId: 'm2', meterReading: 107 });

    // « Je n'ai fait que 2 h sur les 7 » : les 5 autres ne s'effacent pas, elles changent de statut.
    const corrigé = await service.updateUsage(record.id, { startReading: 105 }, 'm2');
    expect(corrigé.duration).toBe(2);
    const history = await service.historyByEquipment('e1', 'm1');
    expect(history.map((e) => [e.record.memberId, e.duration])).toEqual([
      ['m2', 2],
      [null, 5],
      ['m1', null],
    ]);
  });

  it('hors du cercle, un relevé n’existe pas : ni correction ni suppression', async () => {
    const { record } = await service.recordUsage({ ...input, meterReading: 120 });
    await expect(service.updateUsage(record.id, { notes: 'pirate' }, 'm3')).rejects.toThrow(/Relevé introuvable/);
    await expect(service.deleteUsage(record.id, 'm3')).rejects.toThrow(ForbiddenError);
    await expect(service.updateUsage('inconnu', { notes: 'x' }, 'm1')).rejects.toThrow(NotFoundError);
    await expect(service.deleteUsage('inconnu', 'm1')).rejects.toThrow(NotFoundError);
  });

  it('notifie le passage en alerte provoqué par une correction, une seule fois', async () => {
    const notifier = new CapturingNotifier();
    service = new UsageService(f.usageRecords, f.equipments, f.idGenerator, f.clock, notifier);
    await service.recordUsage({ ...input, meterReading: 100, isMaintenance: true });
    const { record } = await service.recordUsage({ ...input, meterReading: 130 });
    expect(notifier.events).toHaveLength(0);

    await service.updateUsage(record.id, { meterReading: 160 }, 'm1');
    expect(notifier.events.map((e) => e.type)).toEqual(['MAINTENANCE_ALERT']);
    // Déjà en alerte : une seconde correction au-dessus du seuil ne la répète pas.
    await service.updateUsage(record.id, { meterReading: 170 }, 'm1');
    expect(notifier.events).toHaveLength(1);
  });

  it('notifie le passage en alerte provoqué par la suppression d’une maintenance', async () => {
    const notifier = new CapturingNotifier();
    service = new UsageService(f.usageRecords, f.equipments, f.idGenerator, f.clock, notifier);
    await service.recordUsage({ ...input, meterReading: 100 });
    const { record: entretien } = await service.recordUsage({ ...input, meterReading: 120, isMaintenance: true });
    await service.recordUsage({ ...input, meterReading: 160 });
    expect(notifier.events).toHaveLength(0);

    // Sans cet entretien, la référence redevient le premier relevé : 60 h écoulées, seuil franchi.
    await service.deleteUsage(entretien.id, 'm1');
    expect(notifier.events.map((e) => e.type)).toEqual(['MAINTENANCE_ALERT']);
  });
});
