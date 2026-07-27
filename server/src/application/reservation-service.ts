import { Reservation } from '../domain/reservation/reservation.js';
import type { ReservationStatus } from '../domain/reservation/reservation.js';
import { findConflicts } from '../domain/reservation/reservation-conflict.js';
import { generateOccurrences } from '../domain/reservation/recurrence.js';
import type { RecurrenceFrequency } from '../domain/reservation/recurrence.js';
import { TimeRange } from '../domain/shared/time-range.js';
import { NotFoundError } from '../domain/shared/domain-error.js';
import { accessibleEquipmentIds, equipmentForMember } from './equipment-access.js';
import type {
  Clock,
  EquipmentRepository,
  IdGenerator,
  MemberRepository,
  Notifier,
  ReservationRepository,
} from './ports.js';

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
    private readonly members?: MemberRepository,
    private readonly notifier?: Notifier,
  ) {}

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const equipment = await equipmentForMember(this.equipments, input.equipmentId, input.memberId);
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

    if (this.notifier) {
      const author = await this.members?.findById(input.memberId);
      const recipientIds = equipment.memberIds.filter((id) => id !== input.memberId);
      if (recipientIds.length > 0) {
        const when = reservation.range.start.toLocaleDateString('fr-FR', {
          day: 'numeric',
          month: 'long',
        });
        await this.notifier.notify({
          type: 'RESERVATION_CREATED',
          recipientIds,
          title: `📅 ${equipment.name}`,
          body: `${author?.name ?? 'Un membre'} a réservé pour le ${when}.`,
          link: `/?tab=calendar`,
        });
      }
    }
    return { reservation, conflicts };
  }

  /** Crée une série de réservations répétées ; chaque occurrence signale ses conflits. */
  async reserveRecurring(input: ReserveInput, recurrence: RecurrenceInput): Promise<ReserveResult[]> {
    await equipmentForMember(this.equipments, input.equipmentId, input.memberId);
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
    requesterId: string,
  ): Promise<ReserveResult> {
    const existing = await this.getReservationForMember(id, requesterId);
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

  async cancel(id: string, requesterId: string): Promise<void> {
    await this.getReservationForMember(id, requesterId);
    await this.reservations.delete(id);
  }

  async listByEquipment(equipmentId: string, requesterId: string): Promise<Reservation[]> {
    await equipmentForMember(this.equipments, equipmentId, requesterId);
    return this.reservations.findByEquipmentId(equipmentId);
  }

  /** Vue calendrier partagée, cadrée sur les équipements du cercle du demandeur. */
  async calendar(requesterId: string): Promise<Reservation[]> {
    const accessible = await accessibleEquipmentIds(this.equipments, requesterId);
    return this.reservations.findByEquipmentIds([...accessible]);
  }

  /**
   * Réservation demandée, à condition que le demandeur partage le cercle de son équipement.
   * Le refus emprunte le message d'absence de la réservation : hors du cercle, elle n'existe pas.
   */
  private async getReservationForMember(id: string, requesterId: string): Promise<Reservation> {
    const absent = `Réservation introuvable : ${id}`;
    const existing = await this.reservations.findById(id);
    if (!existing) {
      throw new NotFoundError(absent);
    }
    await equipmentForMember(this.equipments, existing.equipmentId, requesterId, absent);
    return existing;
  }
}
