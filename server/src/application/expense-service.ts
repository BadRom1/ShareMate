import { Expense } from '../domain/expense/expense.js';
import type { ExpenseCategory, SplitRule } from '../domain/expense/expense.js';
import { Reimbursement } from '../domain/expense/reimbursement.js';
import { computeBalances, settle } from '../domain/expense/settlement.js';
import { Money } from '../domain/shared/money.js';
import { DomainError, NotFoundError } from '../domain/shared/domain-error.js';
import type {
  ExpenseRepository,
  GroupRepository,
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
  groupId: string;
  equipmentId?: string | null;
  label: string;
  amountEuros: number;
  payerId: string;
  date: string;
  category: ExpenseCategory;
  split: SplitInput;
  receiptPath?: string | null;
}

export interface RecordReimbursementInput {
  groupId: string;
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

export class ExpenseService {
  constructor(
    private readonly expenses: ExpenseRepository,
    private readonly reimbursements: ReimbursementRepository,
    private readonly groups: GroupRepository,
    private readonly reservations: ReservationRepository,
    private readonly idGenerator: IdGenerator,
  ) {}

  async addExpense(input: AddExpenseInput): Promise<Expense> {
    const group = await this.groups.findById(input.groupId);
    if (!group) {
      throw new NotFoundError(`Groupe introuvable : ${input.groupId}`);
    }
    if (!group.hasMember(input.payerId)) {
      throw new DomainError(`Le payeur ${input.payerId} n'est pas membre du groupe.`);
    }
    const split = await this.resolveSplit(input, group.memberIds);
    const expense = Expense.create({
      id: this.idGenerator.next(),
      groupId: input.groupId,
      equipmentId: input.equipmentId ?? null,
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

  private async resolveSplit(input: AddExpenseInput, groupMemberIds: readonly string[]): Promise<SplitRule> {
    switch (input.split.type) {
      case 'EQUAL': {
        const memberIds = input.split.memberIds ?? [...groupMemberIds];
        this.assertMembers(memberIds, groupMemberIds);
        return { type: 'EQUAL', memberIds };
      }
      case 'CUSTOM': {
        this.assertMembers(Object.keys(input.split.amountsEuros), groupMemberIds);
        const amounts = Object.fromEntries(
          Object.entries(input.split.amountsEuros).map(([memberId, euros]) => [memberId, Money.fromEuros(euros)]),
        );
        return { type: 'CUSTOM', amounts };
      }
      case 'USAGE_PRORATED': {
        if (!input.equipmentId) {
          throw new DomainError('La répartition au prorata d\'usage requiert un équipement associé à la dépense.');
        }
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
        this.assertMembers(Object.keys(weights), groupMemberIds);
        return { type: 'USAGE_PRORATED', weights };
      }
    }
  }

  private assertMembers(memberIds: string[], groupMemberIds: readonly string[]): void {
    const outsiders = memberIds.filter((m) => !groupMemberIds.includes(m));
    if (outsiders.length > 0) {
      throw new DomainError(`Membres hors du groupe : ${outsiders.join(', ')}`);
    }
  }

  async deleteExpense(id: string): Promise<void> {
    const existing = await this.expenses.findById(id);
    if (!existing) {
      throw new NotFoundError(`Dépense introuvable : ${id}`);
    }
    await this.expenses.delete(id);
  }

  async listExpenses(groupId: string): Promise<Expense[]> {
    const list = await this.expenses.findByGroupId(groupId);
    return list.sort((a, b) => b.date.getTime() - a.date.getTime());
  }

  async recordReimbursement(input: RecordReimbursementInput): Promise<Reimbursement> {
    const group = await this.groups.findById(input.groupId);
    if (!group) {
      throw new NotFoundError(`Groupe introuvable : ${input.groupId}`);
    }
    this.assertMembers([input.fromMemberId, input.toMemberId], group.memberIds);
    const reimbursement = Reimbursement.create({
      id: this.idGenerator.next(),
      groupId: input.groupId,
      fromMemberId: input.fromMemberId,
      toMemberId: input.toMemberId,
      amount: Money.fromEuros(input.amountEuros),
      date: new Date(input.date),
      notes: input.notes ?? null,
    });
    await this.reimbursements.save(reimbursement);
    return reimbursement;
  }

  async listReimbursements(groupId: string): Promise<Reimbursement[]> {
    const list = await this.reimbursements.findByGroupId(groupId);
    return list.sort((a, b) => b.date.getTime() - a.date.getTime());
  }

  /** Solde net par membre du groupe (positif = créditeur). */
  async groupBalances(groupId: string): Promise<MemberBalance[]> {
    const group = await this.groups.findById(groupId);
    if (!group) {
      throw new NotFoundError(`Groupe introuvable : ${groupId}`);
    }
    const balances = computeBalances(
      await this.expenses.findByGroupId(groupId),
      await this.reimbursements.findByGroupId(groupId),
    );
    return group.memberIds.map((memberId) => ({
      memberId,
      balanceCents: balances.get(memberId)?.cents ?? 0,
    }));
  }

  /** Plan de remboursement minimisant le nombre de transactions. */
  async settlementPlan(groupId: string): Promise<SettlementTransactionDto[]> {
    const balances = computeBalances(
      await this.expenses.findByGroupId(groupId),
      await this.reimbursements.findByGroupId(groupId),
    );
    return settle(balances).map((t) => ({
      fromMemberId: t.fromMemberId,
      toMemberId: t.toMemberId,
      amountCents: t.amount.cents,
    }));
  }
}
