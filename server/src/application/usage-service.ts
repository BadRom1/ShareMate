import { UsageRecord } from '../domain/usage/usage-record.js';
import { computeMaintenanceStatus } from '../domain/usage/maintenance-alert.js';
import type { MaintenanceStatus } from '../domain/usage/maintenance-alert.js';
import { DomainError, NotFoundError } from '../domain/shared/domain-error.js';
import type { Clock, EquipmentRepository, IdGenerator, UsageRecordRepository } from './ports.js';

export interface RecordUsageInput {
  equipmentId: string;
  memberId: string;
  meterReading: number;
  fuelAddedLiters?: number | null;
  notes?: string | null;
  isMaintenance?: boolean;
}

export class UsageService {
  constructor(
    private readonly usageRecords: UsageRecordRepository,
    private readonly equipments: EquipmentRepository,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async recordUsage(input: RecordUsageInput): Promise<UsageRecord> {
    const equipment = await this.equipments.findById(input.equipmentId);
    if (!equipment) {
      throw new NotFoundError(`Équipement introuvable : ${input.equipmentId}`);
    }
    if (!equipment.canBeUsedBy(input.memberId)) {
      throw new DomainError(`Le membre ${input.memberId} n'a pas accès à cet équipement.`);
    }
    const existing = await this.usageRecords.findByEquipmentId(input.equipmentId);
    const lastReading = existing.length > 0 ? Math.max(...existing.map((u) => u.meterReading)) : null;
    if (lastReading !== null && input.meterReading < lastReading) {
      throw new DomainError(
        `Le relevé de compteur (${input.meterReading}) ne peut pas être inférieur au dernier relevé connu (${lastReading}).`,
      );
    }
    const record = UsageRecord.create({
      id: this.idGenerator.next(),
      equipmentId: input.equipmentId,
      memberId: input.memberId,
      recordedAt: this.clock.now(),
      meterReading: input.meterReading,
      fuelAddedLiters: input.fuelAddedLiters ?? null,
      notes: input.notes ?? null,
      isMaintenance: input.isMaintenance ?? false,
    });
    await this.usageRecords.save(record);
    return record;
  }

  async historyByEquipment(equipmentId: string): Promise<UsageRecord[]> {
    const records = await this.usageRecords.findByEquipmentId(equipmentId);
    return records.sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
  }

  async historyByMember(memberId: string): Promise<UsageRecord[]> {
    const records = await this.usageRecords.findByMemberId(memberId);
    return records.sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
  }

  async maintenanceStatus(equipmentId: string): Promise<MaintenanceStatus> {
    const equipment = await this.equipments.findById(equipmentId);
    if (!equipment) {
      throw new NotFoundError(`Équipement introuvable : ${equipmentId}`);
    }
    const records = await this.usageRecords.findByEquipmentId(equipmentId);
    return computeMaintenanceStatus(equipment, records);
  }

  /** Statuts en alerte pour tous les équipements du groupe. */
  async groupAlerts(groupId: string): Promise<MaintenanceStatus[]> {
    const equipments = await this.equipments.findByGroupId(groupId);
    const statuses = await Promise.all(
      equipments.map(async (e) =>
        computeMaintenanceStatus(e, await this.usageRecords.findByEquipmentId(e.id)),
      ),
    );
    return statuses.filter((s) => s.alert);
  }
}
