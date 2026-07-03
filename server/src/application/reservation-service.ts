import { Reservation } from '../domain/reservation/reservation.js';
import type { ReservationStatus } from '../domain/reservation/reservation.js';
import { findConflicts } from '../domain/reservation/reservation-conflict.js';
import { generateOccurrences } from '../domain/reservation/recurrence.js';
import type { RecurrenceFrequency } from '../domain/reservation/recurrence.js';
import { TimeRange } from '../domain/shared/time-range.js';
import { DomainError, NotFoundError } from '../domain/shared/domain-error.js';
import type { Clock, EquipmentRepository, IdGenerator, ReservationRepository } from './ports.js';

export interface ReserveInput {
  equipmentId: string;
  memberId: string;
  start: string;
  end: string;
  status?: ReservationStatus;
  notes?: string | null;
}

export interface RecurrenceInput {
  frequency: RecurrenceFrequency;
  /** Dernier jour de répétition, inclus (ISO ou YYYY-MM-DD, interprété fin de journée). */
  until: string;
}

/** Résultat d'une réservation : le conflit n'est pas bloquant, il est signalé. */
export interface ReserveResult {
  reservation: Reservation;
  conflicts: Reservation[];
}

export class ReservationService {
  constructor(
    private readonly reservations: ReservationRepository,
    private readonly equipments: EquipmentRepository,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async reserve(input: ReserveInput): Promise<ReserveResult> {
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
      status: input.status,
      createdAt: this.clock.now(),
      notes: input.notes ?? null,
    });
    const existing = await this.reservations.findByEquipmentId(input.equipmentId);
    const conflicts = findConflicts(reservation, existing);
    await this.reservations.save(reservation);
    return { reservation, conflicts };
  }

  /** Crée une série de réservations répétées ; chaque occurrence signale ses conflits. */
  async reserveRecurring(input: ReserveInput, recurrence: RecurrenceInput): Promise<ReserveResult[]> {
    const equipment = await this.equipments.findById(input.equipmentId);
    if (!equipment) {
      throw new NotFoundError(`Équipement introuvable : ${input.equipmentId}`);
    }
    if (!equipment.canBeUsedBy(input.memberId)) {
      throw new DomainError(`Le membre ${input.memberId} n'a pas accès à cet équipement.`);
    }
    const until = /^\d{4}-\d{2}-\d{2}$/.test(recurrence.until)
      ? new Date(`${recurrence.until}T23:59:59.999`)
      : new Date(recurrence.until);
    const occurrences = generateOccurrences(
      TimeRange.create(new Date(input.start), new Date(input.end)),
      recurrence.frequency,
      until,
    );
    const existing = [...(await this.reservations.findByEquipmentId(input.equipmentId))];
    const results: ReserveResult[] = [];
    for (const range of occurrences) {
      const reservation = Reservation.create({
        id: this.idGenerator.next(),
        equipmentId: input.equipmentId,
        memberId: input.memberId,
        range,
        status: input.status,
        createdAt: this.clock.now(),
        notes: input.notes ?? null,
      });
      results.push({ reservation, conflicts: findConflicts(reservation, existing) });
      existing.push(reservation);
      await this.reservations.save(reservation);
    }
    return results;
  }

  async update(
    id: string,
    changes: { start?: string; end?: string; status?: ReservationStatus; notes?: string | null },
  ): Promise<ReserveResult> {
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
      status: changes.status ?? existing.status,
      createdAt: existing.createdAt,
      notes: changes.notes !== undefined ? changes.notes : existing.notes,
    });
    const others = await this.reservations.findByEquipmentId(existing.equipmentId);
    const conflicts = findConflicts(updated, others);
    await this.reservations.save(updated);
    return { reservation: updated, conflicts };
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

  /** Vue calendrier partagée : réservations de tous les équipements. */
  async calendar(): Promise<Reservation[]> {
    return this.reservations.findAll();
  }
}
