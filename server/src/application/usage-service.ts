import { UsageRecord } from '../domain/usage/usage-record.js';
import { computeMaintenanceStatus } from '../domain/usage/maintenance-alert.js';
import type { MaintenanceStatus } from '../domain/usage/maintenance-alert.js';
import { computeDurations } from '../domain/usage/usage-duration.js';
import { DomainError, NotFoundError } from '../domain/shared/domain-error.js';
import type { Clock, EquipmentRepository, IdGenerator, UsageRecordRepository } from './ports.js';

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
  ) {}

  async recordUsage(input: RecordUsageInput): Promise<UsageEntry> {
    const equipment = await this.equipments.findById(input.equipmentId);
    if (!equipment) {
      throw new NotFoundError(`Équipement introuvable : ${input.equipmentId}`);
    }
    if (!equipment.canBeUsedBy(input.memberId)) {
      throw new DomainError(`Le membre ${input.memberId} n'a pas accès à cet équipement.`);
    }
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
    await this.usageRecords.save(record);
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

  async historyByEquipment(equipmentId: string): Promise<UsageEntry[]> {
    const records = await this.usageRecords.findByEquipmentId(equipmentId);
    const durations = computeDurations(records);
    return records
      .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
      .map((record) => ({ record, duration: durations.get(record.id) ?? null }));
  }

  async historyByMember(memberId: string): Promise<UsageEntry[]> {
    const records = await this.usageRecords.findByMemberId(memberId);
    // La durée dépend du relevé précédent sur l'équipement, quel qu'en soit l'auteur :
    // on recalcule donc sur l'historique complet de chaque équipement concerné.
    const durations = new Map<string, number | null>();
    for (const equipmentId of new Set(records.map((r) => r.equipmentId))) {
      const all = await this.usageRecords.findByEquipmentId(equipmentId);
      for (const [id, duration] of computeDurations(all)) {
        durations.set(id, duration);
      }
    }
    return records
      .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
      .map((record) => ({ record, duration: durations.get(record.id) ?? null }));
  }

  async maintenanceStatus(equipmentId: string): Promise<MaintenanceStatus> {
    const equipment = await this.equipments.findById(equipmentId);
    if (!equipment) {
      throw new NotFoundError(`Équipement introuvable : ${equipmentId}`);
    }
    const records = await this.usageRecords.findByEquipmentId(equipmentId);
    return computeMaintenanceStatus(equipment, records);
  }

  /** Statuts en alerte pour tous les équipements. */
  async alerts(): Promise<MaintenanceStatus[]> {
    const equipments = await this.equipments.findAll();
    const statuses = await Promise.all(
      equipments.map(async (e) => computeMaintenanceStatus(e, await this.usageRecords.findByEquipmentId(e.id))),
    );
    return statuses.filter((s) => s.alert);
  }
}
