import { Money } from '../shared/money.js';
import type { Expense } from './expense.js';
import type { Reimbursement } from './reimbursement.js';

export interface SettlementTransaction {
  fromMemberId: string;
  toMemberId: string;
  amount: Money;
}

/**
 * Solde net par membre : positif = le membre est créditeur (on lui doit),
 * négatif = débiteur. Somme des soldes = 0.
 */
export function computeBalances(
  expenses: readonly Expense[],
  reimbursements: readonly Reimbursement[],
): Map<string, Money> {
  const balances = new Map<string, Money>();
  const adjust = (memberId: string, delta: Money) => {
    balances.set(memberId, (balances.get(memberId) ?? Money.zero()).add(delta));
  };

  for (const expense of expenses) {
    adjust(expense.payerId, expense.amount);
    for (const [memberId, share] of expense.shares()) {
      adjust(memberId, share.negate());
    }
  }
  for (const r of reimbursements) {
    adjust(r.fromMemberId, r.amount);
    adjust(r.toMemberId, r.amount.negate());
  }
  return balances;
}

/**
 * Minimisation du nombre de transactions (algorithme glouton type Tricount) :
 * à chaque étape, le plus gros débiteur rembourse le plus gros créditeur.
 * Produit au plus n-1 transactions et apure exactement tous les soldes.
 */
export function settle(balances: ReadonlyMap<string, Money>): SettlementTransaction[] {
  const creditors: { id: string; cents: number }[] = [];
  const debtors: { id: string; cents: number }[] = [];
  for (const [id, money] of balances) {
    if (money.isPositive()) creditors.push({ id, cents: money.cents });
    else if (money.isNegative()) debtors.push({ id, cents: -money.cents });
  }
  // Tri décroissant, ordre stable par id pour un résultat déterministe.
  creditors.sort((a, b) => b.cents - a.cents || a.id.localeCompare(b.id));
  debtors.sort((a, b) => b.cents - a.cents || a.id.localeCompare(b.id));

  const transactions: SettlementTransaction[] = [];
  let ci = 0;
  let di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const creditor = creditors[ci]!;
    const debtor = debtors[di]!;
    const amount = Math.min(creditor.cents, debtor.cents);
    transactions.push({
      fromMemberId: debtor.id,
      toMemberId: creditor.id,
      amount: Money.fromCents(amount),
    });
    creditor.cents -= amount;
    debtor.cents -= amount;
    if (creditor.cents === 0) ci += 1;
    if (debtor.cents === 0) di += 1;
  }
  return transactions;
}
