import { describe, expect, it } from 'vitest';
import { Money } from '../shared/money.js';
import { Expense } from './expense.js';

const base = {
  id: 'x1',
  groupId: 'g1',
  equipmentId: 'e1',
  label: 'Plein gasoil',
  amount: Money.fromEuros(90),
  payerId: 'm1',
  date: new Date('2026-07-01'),
  category: 'FUEL' as const,
  receiptPath: null,
};

describe('Expense — répartition', () => {
  it('parts égales : chaque membre paie sa part, somme exacte', () => {
    const e = Expense.create({ ...base, split: { type: 'EQUAL', memberIds: ['m1', 'm2', 'm3'] } });
    const shares = e.shares();
    expect(shares.get('m1')!.cents).toBe(3000);
    expect(shares.get('m2')!.cents).toBe(3000);
    expect(shares.get('m3')!.cents).toBe(3000);
  });

  it('parts égales avec reste : la somme des parts égale le montant', () => {
    const e = Expense.create({
      ...base,
      amount: Money.fromCents(1000),
      split: { type: 'EQUAL', memberIds: ['m1', 'm2', 'm3'] },
    });
    const total = [...e.shares().values()].reduce((s, m) => s + m.cents, 0);
    expect(total).toBe(1000);
  });

  it('au prorata de poids (temps d\'usage)', () => {
    const e = Expense.create({
      ...base,
      amount: Money.fromCents(1000),
      split: { type: 'USAGE_PRORATED', weights: { m1: 3, m2: 1 } },
    });
    const shares = e.shares();
    expect(shares.get('m1')!.cents).toBe(750);
    expect(shares.get('m2')!.cents).toBe(250);
  });

  it('montants custom : doivent sommer au montant total', () => {
    const e = Expense.create({
      ...base,
      amount: Money.fromCents(1000),
      split: { type: 'CUSTOM', amounts: { m1: Money.fromCents(700), m2: Money.fromCents(300) } },
    });
    expect(e.shares().get('m1')!.cents).toBe(700);
  });

  it('rejette des montants custom dont la somme diffère du total', () => {
    expect(() =>
      Expense.create({
        ...base,
        amount: Money.fromCents(1000),
        split: { type: 'CUSTOM', amounts: { m1: Money.fromCents(700), m2: Money.fromCents(200) } },
      }),
    ).toThrow();
  });

  it('rejette une répartition égale sans membre', () => {
    expect(() => Expense.create({ ...base, split: { type: 'EQUAL', memberIds: [] } })).toThrow();
  });

  it('rejette un montant négatif ou nul', () => {
    expect(() =>
      Expense.create({ ...base, amount: Money.zero(), split: { type: 'EQUAL', memberIds: ['m1'] } }),
    ).toThrow();
  });

  it('rejette un libellé vide', () => {
    expect(() =>
      Expense.create({ ...base, label: ' ', split: { type: 'EQUAL', memberIds: ['m1'] } }),
    ).toThrow();
  });
});
