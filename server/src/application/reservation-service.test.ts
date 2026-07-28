import { beforeEach, describe, expect, it } from 'vitest';
import { makeFixture } from './testing/fixture.js';
import { ReservationService } from './reservation-service.js';
import { ForbiddenError } from '../domain/shared/domain-error.js';
import { NullNotifier } from './testing/in-memory.js';

let f: Awaited<ReturnType<typeof makeFixture>>;
let service: ReservationService;

beforeEach(async () => {
  f = await makeFixture();
  service = new ReservationService(f.reservations, f.equipments, f.idGenerator, f.clock, f.members, new NullNotifier());
});

const input = {
  equipmentId: 'e1',
  memberId: 'm1',
  start: '2026-07-10T08:00:00Z',
  end: '2026-07-10T12:00:00Z',
};

describe('ReservationService', () => {
  it('réserve un créneau libre, sans conflit', async () => {
    const { reservation, conflicts } = await service.reserve(input);
    expect(reservation.id).toBeTruthy();
    expect(conflicts).toHaveLength(0);
    expect(await f.reservations.findById(reservation.id)).not.toBeNull();
  });

  it('est obligatoire par défaut et accepte le statut prévisionnel', async () => {
    const required = await service.reserve(input);
    expect(required.reservation.status).toBe('REQUIRED');
    const planned = await service.reserve({
      ...input,
      start: '2026-07-11T08:00:00Z',
      end: '2026-07-11T12:00:00Z',
      status: 'PLANNED',
    });
    expect(planned.reservation.status).toBe('PLANNED');
  });

  it('enregistre un créneau en conflit et signale le conflit', async () => {
    const first = await service.reserve(input);
    const second = await service.reserve({
      ...input,
      memberId: 'm2',
      start: '2026-07-10T10:00:00Z',
      end: '2026-07-10T14:00:00Z',
    });
    expect(second.conflicts.map((r) => r.id)).toEqual([first.reservation.id]);
    expect(await f.reservations.findById(second.reservation.id)).not.toBeNull();
  });

  it('accepte un créneau adjacent sans conflit', async () => {
    await service.reserve(input);
    const { conflicts } = await service.reserve({
      ...input,
      memberId: 'm2',
      start: '2026-07-10T12:00:00Z',
      end: '2026-07-10T14:00:00Z',
    });
    expect(conflicts).toHaveLength(0);
  });

  it("refuse un membre hors du cercle de l'équipement", async () => {
    await expect(service.reserve({ ...input, memberId: 'm3' })).rejects.toThrow(ForbiddenError);
  });

  it('refuse un équipement inexistant', async () => {
    await expect(service.reserve({ ...input, equipmentId: 'nope' })).rejects.toThrow(/introuvable/i);
  });

  it('annule une réservation', async () => {
    const { reservation } = await service.reserve(input);
    await service.cancel(reservation.id, 'm1');
    expect(await f.reservations.findById(reservation.id)).toBeNull();
  });

  it('modifie une réservation sans conflit avec elle-même', async () => {
    const { reservation } = await service.reserve(input);
    const updated = await service.update(
      reservation.id,
      { start: '2026-07-10T09:00:00Z', end: '2026-07-10T13:00:00Z' },
      'm1',
    );
    expect(updated.reservation.range.start.toISOString()).toBe('2026-07-10T09:00:00.000Z');
    expect(updated.conflicts).toHaveLength(0);
  });

  it('horodate la réservation à sa création (règle du premier arrivé)', async () => {
    const { reservation } = await service.reserve(input);
    expect(reservation.createdAt.toISOString()).toBe('2026-07-02T10:00:00.000Z');
  });

  it("récurrence hebdomadaire : crée toutes les occurrences jusqu'à la borne", async () => {
    const results = await service.reserveRecurring(input, { frequency: 'WEEKLY', until: '2026-07-24' });
    expect(results).toHaveLength(3); // 10, 17 et 24 juillet
    expect(await f.reservations.findByEquipmentId('e1')).toHaveLength(3);
    expect(results.every((r) => r.conflicts.length === 0)).toBe(true);
  });

  it('récurrence : les occurrences en conflit sont créées et signalées', async () => {
    const blocking = await service.reserve({
      ...input,
      memberId: 'm2',
      start: '2026-07-17T09:00:00Z',
      end: '2026-07-17T10:00:00Z',
    });
    const results = await service.reserveRecurring(input, { frequency: 'WEEKLY', until: '2026-07-24' });
    expect(results.map((r) => r.conflicts.map((c) => c.id))).toEqual([[], [blocking.reservation.id], []]);
  });

  it('récurrence : refuse une borne antérieure au début', async () => {
    await expect(service.reserveRecurring(input, { frequency: 'WEEKLY', until: '2026-07-01' })).rejects.toThrow(
      /répétition/i,
    );
  });

  it('calendrier partagé : les réservations des équipements du cercle du demandeur', async () => {
    await service.reserve(input);
    await service.reserve({ ...input, memberId: 'm2', start: '2026-07-11T08:00:00Z', end: '2026-07-11T10:00:00Z' });
    expect(await service.calendar('m1')).toHaveLength(2);
    // m3 ne partage aucun équipement : son calendrier est vide.
    expect(await service.calendar('m3')).toHaveLength(0);
  });

  it('refuse lecture, modification et annulation à un membre hors du cercle', async () => {
    const { reservation } = await service.reserve(input);
    await expect(service.listByEquipment('e1', 'm3')).rejects.toThrow(ForbiddenError);
    await expect(service.update(reservation.id, { notes: 'pirate' }, 'm3')).rejects.toThrow(ForbiddenError);
    await expect(service.cancel(reservation.id, 'm3')).rejects.toThrow(ForbiddenError);
    expect(await f.reservations.findById(reservation.id)).not.toBeNull();
  });
});
