import { Equipment } from '../domain/equipment/equipment.js';
import type { MeterUnit } from '../domain/equipment/equipment.js';
import { Money } from '../domain/shared/money.js';
import { DomainError } from '../domain/shared/domain-error.js';
import { equipmentForMember, equipmentsForMember } from './equipment-access.js';
import { purgeOrphanReceipts } from './receipt-access.js';
import type { EquipmentRepository, ExpenseRepository, IdGenerator, MemberRepository, ReceiptStorage } from './ports.js';

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
    // Supprimer un équipement emporte ses dépenses (cascade de la persistance) : leurs
    // justificatifs, eux, sont des fichiers, hors de portée de cette cascade.
    private readonly expenses: ExpenseRepository,
    private readonly receipts?: ReceiptStorage,
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

  async create(input: CreateEquipmentInput, creatorId: string): Promise<Equipment> {
    await this.assertMembersExist(input.memberIds);
    // Sans son créateur dans le cercle, l'équipement serait invisible pour lui dès sa création.
    if (!input.memberIds.includes(creatorId)) {
      throw new DomainError("Vous devez faire partie du cercle de l'équipement que vous créez.");
    }
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

  async update(id: string, input: UpdateEquipmentInput, requesterId: string): Promise<Equipment> {
    // Le cercle se coopte : seul un membre peut modifier l'équipement, y compris sa composition.
    const existing = await equipmentForMember(this.equipments, id, requesterId);
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

  async delete(id: string, requesterId: string): Promise<void> {
    await equipmentForMember(this.equipments, id, requesterId);
    // Relevées avant : la cascade les efface avec l'équipement, et plus rien ne nommera leurs fichiers.
    const doomed = await this.expenses.findByEquipmentId(id);
    await this.equipments.delete(id);
    await purgeOrphanReceipts(this.expenses, this.receipts, doomed);
  }

  async getById(id: string, requesterId: string): Promise<Equipment> {
    return equipmentForMember(this.equipments, id, requesterId);
  }

  /** Équipements du cercle du demandeur : les autres n'existent pas pour lui. */
  async list(requesterId: string): Promise<Equipment[]> {
    return equipmentsForMember(this.equipments, requesterId);
  }
}
