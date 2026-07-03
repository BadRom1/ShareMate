import { beforeEach, describe, expect, it } from 'vitest';
import { makeFixture } from './testing/fixture.js';
import { ReservationService } from './reservation-service.js';
import { ConflictError } from '../domain/shared/domain-error.js';

let f: Awaited<ReturnType<typeof makeFixture>>;
let service: ReservationService;

beforeEach(async () => {
  f = await makeFixture();
  service = new ReservationService(f.reservations, f.equipments, f.idGenerator);
});

const input = {
  equipmentId: 'e1',
  memberId: 'm1',
  start: '2026-07-10T08:00:00Z',
  end: '2026-07-10T12:00:00Z',
};

describe('ReservationService', () => {
  it('réserve un créneau libre', async () => {
    const r = await service.reserve(input);
    expect(r.id).toBeTruthy();
    expect(await f.reservations.findById(r.id)).not.toBeNull();
  });

  it('rejette un créneau en conflit sur le même équipement', async () => {
    await service.reserve(input);
    await expect(
      service.reserve({ ...input, memberId: 'm2', start: '2026-07-10T10:00:00Z', end: '2026-07-10T14:00:00Z' }),
    ).rejects.toThrow(ConflictError);
  });

  it('accepte un créneau adjacent', async () => {
    await service.reserve(input);
    await expect(
      service.reserve({ ...input, memberId: 'm2', start: '2026-07-10T12:00:00Z', end: '2026-07-10T14:00:00Z' }),
    ).resolves.toBeTruthy();
  });

  it('refuse un membre sans accès à l\'équipement', async () => {
    await expect(service.reserve({ ...input, memberId: 'm3' })).rejects.toThrow(/accès/i);
  });

  it('refuse un équipement inexistant', async () => {
    await expect(service.reserve({ ...input, equipmentId: 'nope' })).rejects.toThrow(/introuvable/i);
  });

  it('annule une réservation', async () => {
    const r = await service.reserve(input);
    await service.cancel(r.id);
    expect(await f.reservations.findById(r.id)).toBeNull();
  });

  it('modifie une réservation sans conflit avec elle-même', async () => {
    const r = await service.reserve(input);
    const updated = await service.update(r.id, { start: '2026-07-10T09:00:00Z', end: '2026-07-10T13:00:00Z' });
    expect(updated.range.start.toISOString()).toBe('2026-07-10T09:00:00.000Z');
  });

  it('calendrier du groupe : toutes les réservations de tous ses équipements', async () => {
    await service.reserve(input);
    await service.reserve({ ...input, memberId: 'm2', start: '2026-07-11T08:00:00Z', end: '2026-07-11T10:00:00Z' });
    const calendar = await service.groupCalendar('g1');
    expect(calendar).toHaveLength(2);
  });
});
