import { Equipment } from '../domain/equipment/equipment.js';
import type { MeterUnit } from '../domain/equipment/equipment.js';
import { Money } from '../domain/shared/money.js';
import { DomainError, NotFoundError } from '../domain/shared/domain-error.js';
import type { EquipmentRepository, GroupRepository, IdGenerator } from './ports.js';

export interface CreateEquipmentInput {
  groupId: string;
  name: string;
  category: string;
  acquisitionDate: string;
  purchaseValueEuros: number;
  meterUnit: MeterUnit;
  accessMemberIds: string[];
  maintenanceThreshold: number | null;
}

export interface UpdateEquipmentInput {
  name?: string;
  category?: string;
  acquisitionDate?: string;
  purchaseValueEuros?: number;
  meterUnit?: MeterUnit;
  accessMemberIds?: string[];
  maintenanceThreshold?: number | null;
}

export class EquipmentService {
  constructor(
    private readonly equipments: EquipmentRepository,
    private readonly groups: GroupRepository,
    private readonly idGenerator: IdGenerator,
  ) {}

  async create(input: CreateEquipmentInput): Promise<Equipment> {
    const group = await this.groups.findById(input.groupId);
    if (!group) {
      throw new NotFoundError(`Groupe introuvable : ${input.groupId}`);
    }
    const outsiders = input.accessMemberIds.filter((m) => !group.hasMember(m));
    if (outsiders.length > 0) {
      throw new DomainError(`Membres hors du groupe : ${outsiders.join(', ')}`);
    }
    const equipment = Equipment.create({
      id: this.idGenerator.next(),
      groupId: input.groupId,
      name: input.name,
      category: input.category,
      acquisitionDate: new Date(input.acquisitionDate),
      purchaseValue: Money.fromEuros(input.purchaseValueEuros),
      meterUnit: input.meterUnit,
      accessMemberIds: input.accessMemberIds,
      maintenanceThreshold: input.maintenanceThreshold,
    });
    await this.equipments.save(equipment);
    return equipment;
  }

  async update(id: string, input: UpdateEquipmentInput): Promise<Equipment> {
    const existing = await this.equipments.findById(id);
    if (!existing) {
      throw new NotFoundError(`Équipement introuvable : ${id}`);
    }
    if (input.accessMemberIds) {
      const group = await this.groups.findById(existing.groupId);
      const outsiders = input.accessMemberIds.filter((m) => !group?.hasMember(m));
      if (outsiders.length > 0) {
        throw new DomainError(`Membres hors du groupe : ${outsiders.join(', ')}`);
      }
    }
    const updated = existing.update({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.category !== undefined && { category: input.category }),
      ...(input.acquisitionDate !== undefined && { acquisitionDate: new Date(input.acquisitionDate) }),
      ...(input.purchaseValueEuros !== undefined && { purchaseValue: Money.fromEuros(input.purchaseValueEuros) }),
      ...(input.meterUnit !== undefined && { meterUnit: input.meterUnit }),
      ...(input.accessMemberIds !== undefined && { accessMemberIds: input.accessMemberIds }),
      ...(input.maintenanceThreshold !== undefined && { maintenanceThreshold: input.maintenanceThreshold }),
    });
    await this.equipments.save(updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const existing = await this.equipments.findById(id);
    if (!existing) {
      throw new NotFoundError(`Équipement introuvable : ${id}`);
    }
    await this.equipments.delete(id);
  }

  async getById(id: string): Promise<Equipment> {
    const equipment = await this.equipments.findById(id);
    if (!equipment) {
      throw new NotFoundError(`Équipement introuvable : ${id}`);
    }
    return equipment;
  }

  async listByGroup(groupId: string): Promise<Equipment[]> {
    return this.equipments.findByGroupId(groupId);
  }
}
