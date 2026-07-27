import { UsageRecord } from '../domain/usage/usage-record.js';
import { computeMaintenanceStatus } from '../domain/usage/maintenance-alert.js';
import type { MaintenanceStatus } from '../domain/usage/maintenance-alert.js';
import { computeDurations } from '../domain/usage/usage-duration.js';
import { DomainError } from '../domain/shared/domain-error.js';
import { accessibleEquipmentIds, equipmentForMember, equipmentsForMember } from './equipment-access.js';
import type { Clock, EquipmentRepository, IdGenerator, Notifier, UsageRecordRepository } from './ports.js';

export interface RecordUsageInput {
  equipmentId: string;
  memberId: string;
  /** Relevé de compteur en fin d'utilisation. Optionnel si `duration` est fournie. */
  meterReading?: number | null;
  /** Durée d'utilisation (heures/km) : le compteur est alors calculé depuis le dernier relevé connu. */
  duration?: number | null;
  fuelAddedLiters?: number | null;
  notes?: string | null;
  isMaintenance?: boolean;
}

/** Relevé accompagné de la durée attribuée au membre (delta avec le relevé précédent). */
export interface UsageEntry {
  record: UsageRecord;
  duration: number | null;
}

export class UsageService {
  constructor(
    private readonly usageRecords: UsageRecordRepository,
    private readonly equipments: EquipmentRepository,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly notifier: Notifier,
  ) {}

  async recordUsage(input: RecordUsageInput): Promise<UsageEntry> {
    const equipment = await equipmentForMember(this.equipments, input.equipmentId, input.memberId);
    const existing = await this.usageRecords.findByEquipmentId(input.equipmentId);
    const lastReading = existing.length > 0 ? Math.max(...existing.map((u) => u.meterReading)) : null;
    const meterReading = this.resolveMeterReading(input, lastReading);
    if (lastReading !== null && meterReading < lastReading) {
      throw new DomainError(
        `Le relevé de compteur (${meterReading}) ne peut pas être inférieur au dernier relevé connu (${lastReading}).`,
      );
    }
    const record = UsageRecord.create({
      id: this.idGenerator.next(),
      equipmentId: input.equipmentId,
      memberId: input.memberId,
      recordedAt: this.clock.now(),
      meterReading,
      fuelAddedLiters: input.fuelAddedLiters ?? null,
      notes: input.notes ?? null,
      isMaintenance: input.isMaintenance ?? false,
    });
    const statusBefore = computeMaintenanceStatus(equipment, existing);
    await this.usageRecords.save(record);

    const statusAfter = computeMaintenanceStatus(equipment, [...existing, record]);
    // Notifier uniquement au passage en alerte, pas à chaque relevé au-dessus du seuil.
    if (!statusBefore.alert && statusAfter.alert) {
      await this.notifier.notify({
        type: 'MAINTENANCE_ALERT',
        recipientIds: [...equipment.memberIds],
        title: `🔧 Entretien : ${equipment.name}`,
        body: `Le seuil d'entretien est atteint (${statusAfter.unitsSinceMaintenance ?? '?'} ${equipment.meterUnit === 'HOURS' ? 'h' : 'km'} depuis le dernier entretien).`,
        link: `/?tab=usage&equipment=${equipment.id}`,
      });
    }
    return { record, duration: lastReading === null ? null : record.meterReading - lastReading };
  }

  /** Compteur saisi directement, ou calculé « dernier relevé + durée ». */
  private resolveMeterReading(input: RecordUsageInput, lastReading: number | null): number {
    if (input.meterReading != null) {
      return input.meterReading;
    }
    if (input.duration == null) {
      throw new DomainError("Indiquez le relevé de compteur ou la durée d'utilisation.");
    }
    if (!Number.isFinite(input.duration) || input.duration < 0) {
      throw new DomainError("La durée d'utilisation doit être un nombre positif.");
    }
    if (lastReading === null) {
      throw new DomainError('Aucun relevé précédent pour cet équipement : saisissez le relevé de compteur.');
    }
    return lastReading + input.duration;
  }

  async historyByEquipment(equipmentId: string, requesterId: string): Promise<UsageEntry[]> {
    await equipmentForMember(this.equipments, equipmentId, requesterId);
    const records = await this.usageRecords.findByEquipmentId(equipmentId);
    const durations = computeDurations(records);
    return records
      .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
      .map((record) => ({ record, duration: durations.get(record.id) ?? null }));
  }

  /** Historique d'un membre, borné aux équipements que le demandeur partage aussi. */
  async historyByMember(memberId: string, requesterId: string): Promise<UsageEntry[]> {
    const accessible = await accessibleEquipmentIds(this.equipments, requesterId);
    const records = (await this.usageRecords.findByMemberId(memberId)).filter((r) => accessible.has(r.equipmentId));
    // La durée dépend du relevé précédent sur l'équipement, quel qu'en soit l'auteur :
    // on recalcule donc sur l'historique complet des équipements concernés, chargé d'un seul coup.
    const durations = new Map<string, number | null>();
    for (const historique of (await this.historiques([...new Set(records.map((r) => r.equipmentId))])).values()) {
      for (const [id, duration] of computeDurations(historique)) {
        durations.set(id, duration);
      }
    }
    return records
      .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
      .map((record) => ({ record, duration: durations.get(record.id) ?? null }));
  }

  async maintenanceStatus(equipmentId: string, requesterId: string): Promise<MaintenanceStatus> {
    const equipment = await equipmentForMember(this.equipments, equipmentId, requesterId);
    const records = await this.usageRecords.findByEquipmentId(equipmentId);
    return computeMaintenanceStatus(equipment, records);
  }

  /** Statuts en alerte, pour les seuls équipements du cercle du demandeur. */
  async alerts(requesterId: string): Promise<MaintenanceStatus[]> {
    const equipments = await equipmentsForMember(this.equipments, requesterId);
    const historiques = await this.historiques(equipments.map((e) => e.id));
    return equipments.map((e) => computeMaintenanceStatus(e, historiques.get(e.id) ?? [])).filter((s) => s.alert);
  }

  /** Relevés de plusieurs équipements, indexés par équipement, en une seule interrogation. */
  private async historiques(equipmentIds: string[]): Promise<Map<string, UsageRecord[]>> {
    const historiques = new Map<string, UsageRecord[]>(equipmentIds.map((id) => [id, []]));
    for (const record of await this.usageRecords.findByEquipmentIds(equipmentIds)) {
      historiques.get(record.equipmentId)?.push(record);
    }
    return historiques;
  }
}
