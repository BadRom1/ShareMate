import { describe, expect, it } from 'vitest';
import { Money } from '../shared/money.js';
import { Expense } from './expense.js';
import { Reimbursement } from './reimbursement.js';
import { computeBalances, settle } from './settlement.js';

const expense = (id: string, amountCents: number, payerId: string, memberIds: string[]) =>
  Expense.create({
    id,
    equipmentId: 'e1',
    label: `Dépense ${id}`,
    amount: Money.fromCents(amountCents),
    payerId,
    date: new Date('2026-07-01'),
    category: 'OTHER',
    split: { type: 'EQUAL', memberIds },
  });

describe('computeBalances', () => {
  it('sans dépense : soldes nuls', () => {
    const balances = computeBalances([], []);
    expect(balances.size).toBe(0);
  });

  it("une dépense partagée à deux : le payeur est créditeur de la part de l'autre", () => {
    const balances = computeBalances([expense('x1', 1000, 'm1', ['m1', 'm2'])], []);
    expect(balances.get('m1')!.cents).toBe(500); // m1 a avancé 1000, doit 500
    expect(balances.get('m2')!.cents).toBe(-500);
  });

  it('le payeur hors répartition est créditeur du montant total', () => {
    const balances = computeBalances([expense('x1', 900, 'm1', ['m2', 'm3'])], []);
    expect(balances.get('m1')!.cents).toBe(900);
    expect(balances.get('m2')!.cents).toBe(-450);
    expect(balances.get('m3')!.cents).toBe(-450);
  });

  it('les remboursements effectués réduisent les dettes', () => {
    const reimb = Reimbursement.create({
      id: 'r1',
      equipmentId: 'e1',
      fromMemberId: 'm2',
      toMemberId: 'm1',
      amount: Money.fromCents(500),
      date: new Date('2026-07-02'),
    });
    const balances = computeBalances([expense('x1', 1000, 'm1', ['m1', 'm2'])], [reimb]);
    expect(balances.get('m1')!.cents).toBe(0);
    expect(balances.get('m2')!.cents).toBe(0);
  });

  it('la somme des soldes est toujours nulle', () => {
    const balances = computeBalances(
      [
        expense('x1', 999, 'm1', ['m1', 'm2', 'm3']),
        expense('x2', 1234, 'm2', ['m2', 'm3']),
        expense('x3', 57, 'm3', ['m1']),
      ],
      [],
    );
    const total = [...balances.values()].reduce((s, m) => s + m.cents, 0);
    expect(total).toBe(0);
  });
});

describe('settle — minimisation des transactions', () => {
  it('cas simple : un débiteur, un créditeur', () => {
    const balances = computeBalances([expense('x1', 1000, 'm1', ['m1', 'm2'])], []);
    const txs = settle(balances);
    expect(txs).toEqual([{ fromMemberId: 'm2', toMemberId: 'm1', amount: Money.fromCents(500) }]);
  });

  it('chaîne A→B→C réduite à une transaction directe', () => {
    // m1 doit 10 à m2, m2 doit 10 à m3 → une seule transaction m1 → m3
    const balances = new Map([
      ['m1', Money.fromCents(-1000)],
      ['m2', Money.zero()],
      ['m3', Money.fromCents(1000)],
    ]);
    const txs = settle(balances);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toEqual({ fromMemberId: 'm1', toMemberId: 'm3', amount: Money.fromCents(1000) });
  });

  it('n personnes : au plus n-1 transactions', () => {
    const balances = computeBalances(
      [
        expense('x1', 3000, 'm1', ['m1', 'm2', 'm3', 'm4']),
        expense('x2', 2000, 'm2', ['m1', 'm2']),
        expense('x3', 1500, 'm3', ['m2', 'm3', 'm4']),
      ],
      [],
    );
    const txs = settle(balances);
    const involved = new Set([...balances.keys()]);
    expect(txs.length).toBeLessThanOrEqual(involved.size - 1);
  });

  it('les transactions apurent exactement tous les soldes', () => {
    const balances = computeBalances(
      [
        expense('x1', 999, 'm1', ['m1', 'm2', 'm3']),
        expense('x2', 1234, 'm2', ['m2', 'm3']),
        expense('x3', 57, 'm3', ['m1']),
      ],
      [],
    );
    const txs = settle(balances);
    const net = new Map<string, number>();
    for (const [id, m] of balances) net.set(id, m.cents);
    for (const t of txs) {
      net.set(t.fromMemberId, (net.get(t.fromMemberId) ?? 0) + t.amount.cents);
      net.set(t.toMemberId, (net.get(t.toMemberId) ?? 0) - t.amount.cents);
    }
    for (const v of net.values()) expect(v).toBe(0);
  });

  it('soldes équilibrés : aucune transaction', () => {
    expect(settle(new Map([['m1', Money.zero()]]))).toEqual([]);
  });
});
