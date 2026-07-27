import { Expense } from '../domain/expense/expense.js';
import type { ExpenseCategory, SplitRule } from '../domain/expense/expense.js';
import { Reimbursement } from '../domain/expense/reimbursement.js';
import { computeBalances, settle } from '../domain/expense/settlement.js';
import { Money } from '../domain/shared/money.js';
import { DomainError, NotFoundError } from '../domain/shared/domain-error.js';
import { equipmentForMember } from './equipment-access.js';
import { expenseForReceipt, purgeOrphanReceipts } from './receipt-access.js';
import type {
  EquipmentRepository,
  ExpenseRepository,
  IdGenerator,
  MemberRepository,
  Notifier,
  ReceiptStorage,
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
    private readonly members?: MemberRepository,
    private readonly notifier?: Notifier,
    private readonly receipts?: ReceiptStorage,
  ) {}

  private formatEuros(euros: number): string {
    return euros.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
  }

  private async getEquipment(equipmentId: string) {
    const equipment = await this.equipments.findById(equipmentId);
    if (!equipment) {
      throw new NotFoundError(`Équipement introuvable : ${equipmentId}`);
    }
    return equipment;
  }

  async addExpense(input: AddExpenseInput, requesterId: string): Promise<Expense> {
    const equipment = await equipmentForMember(this.equipments, input.equipmentId, requesterId);
    if (!equipment.canBeUsedBy(input.payerId)) {
      throw new DomainError(`Le payeur ${input.payerId} ne fait pas partie du cercle de l'équipement.`);
    }
    // Un justificatif appartient à une seule dépense : chaque téléversement produit un nom neuf.
    // Sans cette borne, recopier le chemin d'un fichier d'un autre cercle dans sa propre dépense
    // suffirait à s'en ouvrir la lecture (voir receipt-access.ts), et sa purge deviendrait ambiguë.
    if (input.receiptPath && (await this.expenses.findByReceiptPath(input.receiptPath)).length > 0) {
      throw new DomainError('Ce justificatif est déjà rattaché à une dépense.');
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

    if (this.notifier) {
      const payer = await this.members?.findById(input.payerId);
      const recipientIds = equipment.memberIds.filter((id) => id !== input.payerId);
      if (recipientIds.length > 0) {
        await this.notifier.notify({
          type: 'EXPENSE_ADDED',
          recipientIds,
          title: `💶 ${equipment.name}`,
          body: `${payer?.name ?? 'Un membre'} a ajouté « ${expense.label} » (${this.formatEuros(input.amountEuros)}).`,
          link: `/?tab=expenses&equipment=${equipment.id}`,
        });
      }
    }
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

  async deleteExpense(id: string, requesterId: string): Promise<void> {
    const absent = `Dépense introuvable : ${id}`;
    const existing = await this.expenses.findById(id);
    if (!existing) {
      throw new NotFoundError(absent);
    }
    // Hors du cercle, la dépense se comporte comme inexistante (même réponse qu'un id inconnu).
    await equipmentForMember(this.equipments, existing.equipmentId, requesterId, absent);
    await this.expenses.delete(id);
    await purgeOrphanReceipts(this.expenses, this.receipts, [existing]);
  }

  /**
   * Dépense portant ce justificatif, si le demandeur y a accès. L'adapter HTTP s'en sert pour
   * autoriser la lecture du fichier avant de le servir : lui seul sait où il est rangé.
   */
  async receiptOwner(receiptPath: string, requesterId: string): Promise<Expense> {
    return expenseForReceipt(this.expenses, this.equipments, receiptPath, requesterId);
  }

  async listExpenses(equipmentId: string, requesterId: string): Promise<Expense[]> {
    await equipmentForMember(this.equipments, equipmentId, requesterId);
    const list = await this.expenses.findByEquipmentId(equipmentId);
    return list.sort((a, b) => b.date.getTime() - a.date.getTime());
  }

  async recordReimbursement(input: RecordReimbursementInput, requesterId: string): Promise<Reimbursement> {
    const equipment = await equipmentForMember(this.equipments, input.equipmentId, requesterId);
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

    if (this.notifier) {
      const from = await this.members?.findById(input.fromMemberId);
      await this.notifier.notify({
        type: 'REIMBURSEMENT_RECORDED',
        recipientIds: [input.toMemberId],
        title: `✅ Remboursement — ${equipment.name}`,
        body: `${from?.name ?? 'Un membre'} vous a remboursé ${this.formatEuros(input.amountEuros)}.`,
        link: `/?tab=expenses&equipment=${equipment.id}`,
      });
    }
    return reimbursement;
  }

  async listReimbursements(equipmentId: string, requesterId: string): Promise<Reimbursement[]> {
    await equipmentForMember(this.equipments, equipmentId, requesterId);
    const list = await this.reimbursements.findByEquipmentId(equipmentId);
    return list.sort((a, b) => b.date.getTime() - a.date.getTime());
  }

  /** Solde net par membre du cercle de l'équipement (positif = créditeur). */
  async equipmentBalances(equipmentId: string, requesterId: string): Promise<MemberBalance[]> {
    const equipment = await equipmentForMember(this.equipments, equipmentId, requesterId);
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
  async settlementPlan(equipmentId: string, requesterId: string): Promise<SettlementTransactionDto[]> {
    await equipmentForMember(this.equipments, equipmentId, requesterId);
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
