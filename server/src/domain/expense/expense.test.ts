import { describe, expect, it } from 'vitest';
import { Money } from '../shared/money.js';
import { Expense } from './expense.js';
import { computeBalances } from './settlement.js';

const base = {
  id: 'x1',
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

  it("au prorata de poids (temps d'usage)", () => {
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

  it('rejette une date illisible', () => {
    expect(() =>
      Expense.create({ ...base, date: new Date('9999-99-99'), split: { type: 'EQUAL', memberIds: ['m1'] } }),
    ).toThrow();
  });

  it('rejette un libellé vide', () => {
    expect(() => Expense.create({ ...base, label: ' ', split: { type: 'EQUAL', memberIds: ['m1'] } })).toThrow();
  });
});

describe('Expense — fusion de deux comptes du même membre', () => {
  it('renomme le payeur', () => {
    const e = Expense.create({ ...base, payerId: 'ancien', split: { type: 'EQUAL', memberIds: ['m2'] } });
    expect(e.mergeMembers('ancien', 'nouveau').payerId).toBe('nouveau');
  });

  it('l’absorbé seul dans la répartition : la règle est conservée, les parts ne bougent pas', () => {
    const e = Expense.create({ ...base, split: { type: 'EQUAL', memberIds: ['ancien', 'm2', 'm3'] } });
    const fusionnée = e.mergeMembers('ancien', 'nouveau');
    expect(fusionnée.split).toEqual({ type: 'EQUAL', memberIds: ['nouveau', 'm2', 'm3'] });
    expect(fusionnée.shares().get('nouveau')!.cents).toBe(e.shares().get('ancien')!.cents);
  });

  it('les deux dans la même répartition égale : les parts s’additionnent, la somme vaut le montant', () => {
    const e = Expense.create({ ...base, split: { type: 'EQUAL', memberIds: ['ancien', 'nouveau', 'm3'] } });
    const fusionnée = e.mergeMembers('ancien', 'nouveau');
    const parts = fusionnée.shares();
    // 30 € + 30 €, et non les 45 € qu'un partage à deux aurait produits.
    expect(parts.get('nouveau')!.cents).toBe(6000);
    expect(parts.get('m3')!.cents).toBe(3000);
    expect(parts.has('ancien')).toBe(false);
    expect([...parts.values()].reduce((s, m) => s.add(m), Money.zero()).cents).toBe(9000);
  });

  it('parts égales avec reste : la somme reste exacte après fusion', () => {
    const e = Expense.create({
      ...base,
      amount: Money.fromCents(1000),
      split: { type: 'EQUAL', memberIds: ['ancien', 'nouveau', 'm3'] },
    });
    const avant = e.shares();
    const parts = e.mergeMembers('ancien', 'nouveau').shares();
    expect(parts.get('nouveau')!.cents).toBe(avant.get('ancien')!.cents + avant.get('nouveau')!.cents);
    expect([...parts.values()].reduce((s, m) => s.add(m), Money.zero()).cents).toBe(1000);
  });

  it('au prorata : le poids seul est renommé, les deux poids sont additionnés en montants', () => {
    const seul = Expense.create({ ...base, split: { type: 'USAGE_PRORATED', weights: { ancien: 2, m2: 1 } } });
    expect(seul.mergeMembers('ancien', 'nouveau').split).toEqual({
      type: 'USAGE_PRORATED',
      weights: { nouveau: 2, m2: 1 },
    });

    const deux = Expense.create({
      ...base,
      split: { type: 'USAGE_PRORATED', weights: { ancien: 1, nouveau: 1, m2: 1 } },
    });
    const parts = deux.mergeMembers('ancien', 'nouveau').shares();
    expect(parts.get('nouveau')!.cents).toBe(6000);
    expect(parts.get('m2')!.cents).toBe(3000);
  });

  it('montants personnalisés : les deux montants s’additionnent et la dépense reste valide', () => {
    const e = Expense.create({
      ...base,
      split: {
        type: 'CUSTOM',
        amounts: { ancien: Money.fromEuros(20), nouveau: Money.fromEuros(30), m3: Money.fromEuros(40) },
      },
    });
    const fusionnée = e.mergeMembers('ancien', 'nouveau');
    expect(fusionnée.shares().get('nouveau')!.cents).toBe(5000);
    // La validation de `create` est celle du rechargement : la dépense se relira.
    expect(() => Expense.create({ ...base, split: fusionnée.split })).not.toThrow();
  });

  it('ne touche pas une dépense étrangère aux deux comptes', () => {
    const e = Expense.create({ ...base, split: { type: 'EQUAL', memberIds: ['m2', 'm3'] } });
    expect(e.mergeMembers('ancien', 'nouveau')).toBe(e);
  });

  it('les soldes de l’équipement sont identiques avant et après, les deux lignes réunies', () => {
    const dépenses = [
      Expense.create({ ...base, id: 'x1', payerId: 'ancien', split: { type: 'EQUAL', memberIds: ['nouveau', 'm3'] } }),
      Expense.create({
        ...base,
        id: 'x2',
        payerId: 'm3',
        amount: Money.fromCents(1000),
        split: { type: 'EQUAL', memberIds: ['ancien', 'nouveau', 'm3'] },
      }),
    ];
    const avant = computeBalances(dépenses, []);
    const après = computeBalances(
      dépenses.map((d) => d.mergeMembers('ancien', 'nouveau')),
      [],
    );
    expect(après.get('nouveau')!.cents).toBe(avant.get('ancien')!.cents + avant.get('nouveau')!.cents);
    expect(après.get('m3')!.cents).toBe(avant.get('m3')!.cents);
    expect(après.has('ancien')).toBe(false);
  });
});
