import { DomainError } from '../shared/domain-error.js';
import { Money } from '../shared/money.js';

export const EXPENSE_CATEGORIES = ['PURCHASE', 'INSURANCE', 'FUEL', 'MAINTENANCE', 'REPAIR', 'OTHER'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** Règle de répartition d'une dépense entre membres. */
export type SplitRule =
  | { type: 'EQUAL'; memberIds: string[] }
  | { type: 'USAGE_PRORATED'; weights: Record<string, number> }
  | { type: 'CUSTOM'; amounts: Record<string, Money> };

export interface ExpenseProps {
  id: string;
  equipmentId: string;
  label: string;
  amount: Money;
  payerId: string;
  date: Date;
  category: ExpenseCategory;
  split: SplitRule;
  receiptPath?: string | null;
}

/** Dépense liée à un équipement, répartie entre les membres de son cercle selon une règle configurable. */
export class Expense {
  private constructor(
    readonly id: string,
    readonly equipmentId: string,
    readonly label: string,
    readonly amount: Money,
    readonly payerId: string,
    readonly date: Date,
    readonly category: ExpenseCategory,
    readonly split: SplitRule,
    readonly receiptPath: string | null,
  ) {}

  static create(props: ExpenseProps): Expense {
    const label = props.label.trim();
    if (label.length === 0) {
      throw new DomainError('Le libellé de la dépense est requis.');
    }
    if (!props.amount.isPositive()) {
      throw new DomainError('Le montant de la dépense doit être strictement positif.');
    }
    Expense.validateSplit(props.split, props.amount);
    return new Expense(
      props.id,
      props.equipmentId,
      label,
      props.amount,
      props.payerId,
      new Date(props.date),
      props.category,
      props.split,
      props.receiptPath ?? null,
    );
  }

  private static validateSplit(split: SplitRule, amount: Money): void {
    switch (split.type) {
      case 'EQUAL':
        if (split.memberIds.length === 0) {
          throw new DomainError('Une répartition égale requiert au moins un membre.');
        }
        break;
      case 'USAGE_PRORATED': {
        const weights = Object.values(split.weights);
        if (weights.length === 0 || weights.reduce((s, w) => s + w, 0) <= 0) {
          throw new DomainError("Une répartition au prorata requiert des poids d'usage positifs.");
        }
        break;
      }
      case 'CUSTOM': {
        const entries = Object.values(split.amounts);
        if (entries.length === 0) {
          throw new DomainError('Une répartition custom requiert au moins un montant.');
        }
        const sum = entries.reduce((s, m) => s.add(m), Money.zero());
        if (!sum.equals(amount)) {
          throw new DomainError(
            `La somme des montants custom (${sum.toEuros()} €) doit égaler le montant de la dépense (${amount.toEuros()} €).`,
          );
        }
        break;
      }
    }
  }

  /** Part due par chaque membre pour cette dépense. */
  shares(): Map<string, Money> {
    const result = new Map<string, Money>();
    switch (this.split.type) {
      case 'EQUAL': {
        const parts = this.amount.splitEqually(this.split.memberIds.length);
        this.split.memberIds.forEach((memberId, i) => result.set(memberId, parts[i]!));
        break;
      }
      case 'USAGE_PRORATED': {
        const memberIds = Object.keys(this.split.weights);
        const weights = memberIds.map((id) => (this.split as { weights: Record<string, number> }).weights[id]!);
        const parts = this.amount.splitByWeights(weights);
        memberIds.forEach((memberId, i) => result.set(memberId, parts[i]!));
        break;
      }
      case 'CUSTOM': {
        for (const [memberId, share] of Object.entries(this.split.amounts)) {
          result.set(memberId, share);
        }
        break;
      }
    }
    return result;
  }
}
