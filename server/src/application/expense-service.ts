import { Expense } from '../domain/expense/expense.js';
import type { ExpenseCategory, SplitRule } from '../domain/expense/expense.js';
import { Reimbursement } from '../domain/expense/reimbursement.js';
import { computeBalances, settle } from '../domain/expense/settlement.js';
import { Money } from '../domain/shared/money.js';
import { DomainError, NotFoundError } from '../domain/shared/domain-error.js';
import type {
  EquipmentRepository,
  ExpenseRepository,
  IdGenerator,
  ReimbursementRepository,
  ReservationRepository,
} from './ports.js';

/** Règle de répartition côté API : montants en euros, poids optionnels. */
export type SplitInput =
  | { type: 'EQUAL'; memberIds?: string[] }
  | { type: 'USAGE_PRORATED' }
  | { type: 'CUSTOM'; amountsEuros: Record<string, number> };

export interface AddExpenseInput {
  equipmentId: string;
  label: string;
  amountEuros: number;
  payerId: string;
  date: string;
  category: ExpenseCategory;
  split: SplitInput;
  receiptPath?: string | null;
}

export interface RecordReimbursementInput {
  equipmentId: string;
  fromMemberId: string;
  toMemberId: string;
  amountEuros: number;
  date: string;
  notes?: string | null;
}

export interface MemberBalance {
  memberId: string;
  balanceCents: number;
}

export interface SettlementTransactionDto {
  fromMemberId: string;
  toMemberId: string;
  amountCents: number;
}

/** Dépenses, soldes et remboursements — tout est scopé au cercle d'un équipement. */
export class ExpenseService {
  constructor(
    private readonly expenses: ExpenseRepository,
    private readonly reimbursements: ReimbursementRepository,
    private readonly equipments: EquipmentRepository,
    private readonly reservations: ReservationRepository,
    private readonly idGenerator: IdGenerator,
  ) {}

  private async getEquipment(equipmentId: string) {
    const equipment = await this.equipments.findById(equipmentId);
    if (!equipment) {
      throw new NotFoundError(`Équipement introuvable : ${equipmentId}`);
    }
    return equipment;
  }

  async addExpense(input: AddExpenseInput): Promise<Expense> {
    const equipment = await this.getEquipment(input.equipmentId);
    if (!equipment.canBeUsedBy(input.payerId)) {
      throw new DomainError(`Le payeur ${input.payerId} ne fait pas partie du cercle de l'équipement.`);
    }
    const split = await this.resolveSplit(input, equipment.memberIds);
    const expense = Expense.create({
      id: this.idGenerator.next(),
      equipmentId: input.equipmentId,
      label: input.label,
      amount: Money.fromEuros(input.amountEuros),
      payerId: input.payerId,
      date: new Date(input.date),
      category: input.category,
      split,
      receiptPath: input.receiptPath ?? null,
    });
    await this.expenses.save(expense);
    return expense;
  }

  private async resolveSplit(input: AddExpenseInput, circleMemberIds: readonly string[]): Promise<SplitRule> {
    switch (input.split.type) {
      case 'EQUAL': {
        const memberIds = input.split.memberIds ?? [...circleMemberIds];
        this.assertInCircle(memberIds, circleMemberIds);
        return { type: 'EQUAL', memberIds };
      }
      case 'CUSTOM': {
        this.assertInCircle(Object.keys(input.split.amountsEuros), circleMemberIds);
        const amounts = Object.fromEntries(
          Object.entries(input.split.amountsEuros).map(([memberId, euros]) => [memberId, Money.fromEuros(euros)]),
        );
        return { type: 'CUSTOM', amounts };
      }
      case 'USAGE_PRORATED': {
        // Poids = heures réservées par membre sur cet équipement.
        const reservations = await this.reservations.findByEquipmentId(input.equipmentId);
        const weights: Record<string, number> = {};
        for (const r of reservations) {
          weights[r.memberId] = (weights[r.memberId] ?? 0) + r.range.durationHours();
        }
        if (Object.keys(weights).length === 0) {
          throw new DomainError(
            "Aucune donnée d'usage (réservation) pour cet équipement : impossible de calculer le prorata.",
          );
        }
        this.assertInCircle(Object.keys(weights), circleMemberIds);
        return { type: 'USAGE_PRORATED', weights };
      }
    }
  }

  private assertInCircle(memberIds: string[], circleMemberIds: readonly string[]): void {
    const outsiders = memberIds.filter((m) => !circleMemberIds.includes(m));
    if (outsiders.length > 0) {
      throw new DomainError(`Membres hors du cercle de l'équipement : ${outsiders.join(', ')}`);
    }
  }

  async deleteExpense(id: string): Promise<void> {
    const existing = await this.expenses.findById(id);
    if (!existing) {
      throw new NotFoundError(`Dépense introuvable : ${id}`);
    }
    await this.expenses.delete(id);
  }

  async listExpenses(equipmentId: string): Promise<Expense[]> {
    const list = await this.expenses.findByEquipmentId(equipmentId);
    return list.sort((a, b) => b.date.getTime() - a.date.getTime());
  }

  async recordReimbursement(input: RecordReimbursementInput): Promise<Reimbursement> {
    const equipment = await this.getEquipment(input.equipmentId);
    this.assertInCircle([input.fromMemberId, input.toMemberId], equipment.memberIds);
    const reimbursement = Reimbursement.create({
      id: this.idGenerator.next(),
      equipmentId: input.equipmentId,
      fromMemberId: input.fromMemberId,
      toMemberId: input.toMemberId,
      amount: Money.fromEuros(input.amountEuros),
      date: new Date(input.date),
      notes: input.notes ?? null,
    });
    await this.reimbursements.save(reimbursement);
    return reimbursement;
  }

  async listReimbursements(equipmentId: string): Promise<Reimbursement[]> {
    const list = await this.reimbursements.findByEquipmentId(equipmentId);
    return list.sort((a, b) => b.date.getTime() - a.date.getTime());
  }

  /** Solde net par membre du cercle de l'équipement (positif = créditeur). */
  async equipmentBalances(equipmentId: string): Promise<MemberBalance[]> {
    const equipment = await this.getEquipment(equipmentId);
    const balances = computeBalances(
      await this.expenses.findByEquipmentId(equipmentId),
      await this.reimbursements.findByEquipmentId(equipmentId),
    );
    return equipment.memberIds.map((memberId) => ({
      memberId,
      balanceCents: balances.get(memberId)?.cents ?? 0,
    }));
  }

  /** Plan de remboursement minimisant le nombre de transactions, pour un équipement. */
  async settlementPlan(equipmentId: string): Promise<SettlementTransactionDto[]> {
    await this.getEquipment(equipmentId);
    const balances = computeBalances(
      await this.expenses.findByEquipmentId(equipmentId),
      await this.reimbursements.findByEquipmentId(equipmentId),
    );
    return settle(balances).map((t) => ({
      fromMemberId: t.fromMemberId,
      toMemberId: t.toMemberId,
      amountCents: t.amount.cents,
    }));
  }
}
