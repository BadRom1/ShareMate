import { DomainError } from '../shared/domain-error.js';
import { assertValidDate } from '../shared/iso-date.js';
import { Money } from '../shared/money.js';

export const EXPENSE_CATEGORIES = ['PURCHASE', 'INSURANCE', 'FUEL', 'MAINTENANCE', 'REPAIR', 'OTHER'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** Règle de répartition d'une dépense entre membres. */
export type SplitRule =
  | { type: 'EQUAL'; memberIds: string[] }
  | { type: 'USAGE_PRORATED'; weights: Record<string, number> }
  | { type: 'CUSTOM'; amounts: Record<string, Money> };

/**
 * Parts figées, celles de l'absorbé versées à celles du conservé. La somme est inchangée : on
 * déplace des montants déjà calculés, on n'en recalcule aucun.
 */
function mergedShares(shares: ReadonlyMap<string, Money>, absorbedId: string, keptId: string): Record<string, Money> {
  const amounts: Record<string, Money> = {};
  for (const [memberId, share] of shares) {
    if (memberId === absorbedId) continue;
    amounts[memberId] = memberId === keptId ? share.add(shares.get(absorbedId) ?? Money.zero()) : share;
  }
  return amounts;
}

/**
 * Identifiant remplacé dans une répartition, à sa place. L'appelant a vérifié que le conservé n'y
 * figure pas déjà : sans cela, renommer écraserait une entrée au lieu de l'additionner.
 */
function renameInSplit(split: SplitRule, absorbedId: string, keptId: string): SplitRule {
  const rename = (memberId: string) => (memberId === absorbedId ? keptId : memberId);
  switch (split.type) {
    case 'EQUAL':
      return { type: 'EQUAL', memberIds: split.memberIds.map(rename) };
    case 'USAGE_PRORATED':
      return {
        type: 'USAGE_PRORATED',
        weights: Object.fromEntries(Object.entries(split.weights).map(([id, w]) => [rename(id), w])),
      };
    case 'CUSTOM':
      return {
        type: 'CUSTOM',
        amounts: Object.fromEntries(Object.entries(split.amounts).map(([id, m]) => [rename(id), m])),
      };
  }
}

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
    assertValidDate(props.date, 'La date de la dépense');
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

  /**
   * Même dépense, deux comptes du même membre réunis en un seul (voir la fusion de comptes).
   *
   * Le payeur se renomme. La répartition, elle, dépend de ce qu'elle contient :
   *
   * - l'absorbé seul y figure : son identifiant est remplacé, **la règle est conservée**. Les
   *   parts ne bougent pas d'un centime, et une dépense « en parts égales » le reste ;
   * - les deux y figurent : les renommer laisserait une clé unique là où il y avait deux entrées,
   *   et **la part du membre changerait** — trois parts égales de 30 € deviendraient deux parts de
   *   45 €, alors que la personne devait bien 60 €. La règle est donc figée en montants
   *   personnalisés, calculés avant la fusion et **additionnés** pour le compte conservé. C'est le
   *   seul cas où une fusion change la nature d'une répartition : c'est le prix des soldes
   *   inchangés, et `shares()` couvrant exactement le montant, la somme reste valide.
   */
  mergeMembers(absorbedId: string, keptId: string): Expense {
    const parts = this.shares();
    const payerId = this.payerId === absorbedId ? keptId : this.payerId;
    if (!parts.has(absorbedId)) {
      return payerId === this.payerId ? this : this.withPayerAndSplit(payerId, this.split);
    }
    const split: SplitRule = parts.has(keptId)
      ? { type: 'CUSTOM', amounts: mergedShares(parts, absorbedId, keptId) }
      : renameInSplit(this.split, absorbedId, keptId);
    return this.withPayerAndSplit(payerId, split);
  }

  private withPayerAndSplit(payerId: string, split: SplitRule): Expense {
    return Expense.create({
      id: this.id,
      equipmentId: this.equipmentId,
      label: this.label,
      amount: this.amount,
      payerId,
      date: this.date,
      category: this.category,
      split,
      receiptPath: this.receiptPath,
    });
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
