import { Equipment } from '../domain/equipment/equipment.js';
import type { MeterUnit } from '../domain/equipment/equipment.js';
import { Money } from '../domain/shared/money.js';
import { DomainError, NotFoundError } from '../domain/shared/domain-error.js';
import type { EquipmentRepository, IdGenerator, MemberRepository } from './ports.js';

export interface CreateEquipmentInput {
  name: string;
  category: string;
  acquisitionDate: string;
  purchaseValueEuros: number;
  meterUnit: MeterUnit;
  memberIds: string[];
  maintenanceThreshold: number | null;
}

export interface UpdateEquipmentInput {
  name?: string;
  category?: string;
  acquisitionDate?: string;
  purchaseValueEuros?: number;
  meterUnit?: MeterUnit;
  memberIds?: string[];
  maintenanceThreshold?: number | null;
}

export class EquipmentService {
  constructor(
    private readonly equipments: EquipmentRepository,
    private readonly members: MemberRepository,
    private readonly idGenerator: IdGenerator,
  ) {}

  private async assertMembersExist(memberIds: string[]): Promise<void> {
    const unknown: string[] = [];
    for (const memberId of memberIds) {
      if (!(await this.members.findById(memberId))) {
        unknown.push(memberId);
      }
    }
    if (unknown.length > 0) {
      throw new DomainError(`Membres inconnus : ${unknown.join(', ')}`);
    }
  }

  async create(input: CreateEquipmentInput): Promise<Equipment> {
    await this.assertMembersExist(input.memberIds);
    const equipment = Equipment.create({
      id: this.idGenerator.next(),
      name: input.name,
      category: input.category,
      acquisitionDate: new Date(input.acquisitionDate),
      purchaseValue: Money.fromEuros(input.purchaseValueEuros),
      meterUnit: input.meterUnit,
      memberIds: input.memberIds,
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
    if (input.memberIds) {
      await this.assertMembersExist(input.memberIds);
    }
    const updated = existing.update({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.category !== undefined && { category: input.category }),
      ...(input.acquisitionDate !== undefined && { acquisitionDate: new Date(input.acquisitionDate) }),
      ...(input.purchaseValueEuros !== undefined && { purchaseValue: Money.fromEuros(input.purchaseValueEuros) }),
      ...(input.meterUnit !== undefined && { meterUnit: input.meterUnit }),
      ...(input.memberIds !== undefined && { memberIds: input.memberIds }),
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

  async list(): Promise<Equipment[]> {
    return this.equipments.findAll();
  }
}
