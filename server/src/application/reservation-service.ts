import { Reservation } from '../domain/reservation/reservation.js';
import { assertNoConflict } from '../domain/reservation/reservation-conflict.js';
import { TimeRange } from '../domain/shared/time-range.js';
import { DomainError, NotFoundError } from '../domain/shared/domain-error.js';
import type { EquipmentRepository, IdGenerator, ReservationRepository } from './ports.js';

export interface ReserveInput {
  equipmentId: string;
  memberId: string;
  start: string;
  end: string;
  notes?: string | null;
}

export class ReservationService {
  constructor(
    private readonly reservations: ReservationRepository,
    private readonly equipments: EquipmentRepository,
    private readonly idGenerator: IdGenerator,
  ) {}

  async reserve(input: ReserveInput): Promise<Reservation> {
    const equipment = await this.equipments.findById(input.equipmentId);
    if (!equipment) {
      throw new NotFoundError(`Équipement introuvable : ${input.equipmentId}`);
    }
    if (!equipment.canBeUsedBy(input.memberId)) {
      throw new DomainError(`Le membre ${input.memberId} n'a pas accès à cet équipement.`);
    }
    const reservation = Reservation.create({
      id: this.idGenerator.next(),
      equipmentId: input.equipmentId,
      memberId: input.memberId,
      range: TimeRange.create(new Date(input.start), new Date(input.end)),
      notes: input.notes ?? null,
    });
    const existing = await this.reservations.findByEquipmentId(input.equipmentId);
    assertNoConflict(reservation, existing);
    await this.reservations.save(reservation);
    return reservation;
  }

  async update(id: string, changes: { start?: string; end?: string; notes?: string | null }): Promise<Reservation> {
    const existing = await this.reservations.findById(id);
    if (!existing) {
      throw new NotFoundError(`Réservation introuvable : ${id}`);
    }
    const updated = Reservation.create({
      id: existing.id,
      equipmentId: existing.equipmentId,
      memberId: existing.memberId,
      range: TimeRange.create(
        changes.start ? new Date(changes.start) : existing.range.start,
        changes.end ? new Date(changes.end) : existing.range.end,
      ),
      notes: changes.notes !== undefined ? changes.notes : existing.notes,
    });
    const others = await this.reservations.findByEquipmentId(existing.equipmentId);
    assertNoConflict(updated, others);
    await this.reservations.save(updated);
    return updated;
  }

  async cancel(id: string): Promise<void> {
    const existing = await this.reservations.findById(id);
    if (!existing) {
      throw new NotFoundError(`Réservation introuvable : ${id}`);
    }
    await this.reservations.delete(id);
  }

  async listByEquipment(equipmentId: string): Promise<Reservation[]> {
    return this.reservations.findByEquipmentId(equipmentId);
  }

  /** Vue calendrier partagée : réservations de tous les équipements du groupe. */
  async groupCalendar(groupId: string): Promise<Reservation[]> {
    const equipments = await this.equipments.findByGroupId(groupId);
    return this.reservations.findByEquipmentIds(equipments.map((e) => e.id));
  }
}
