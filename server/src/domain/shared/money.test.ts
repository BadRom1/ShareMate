import { describe, expect, it } from 'vitest';
import { Money } from './money.js';

describe('Money', () => {
  it('se construit à partir de centimes', () => {
    const m = Money.fromCents(1250);
    expect(m.cents).toBe(1250);
  });

  it('se construit à partir d\'euros décimaux avec arrondi au centime', () => {
    expect(Money.fromEuros(12.5).cents).toBe(1250);
    expect(Money.fromEuros(0.1).cents).toBe(10);
    expect(Money.fromEuros(10.005).cents).toBe(1001);
  });

  it('rejette les montants non entiers en centimes', () => {
    expect(() => Money.fromCents(10.5)).toThrow();
    expect(() => Money.fromCents(NaN)).toThrow();
  });

  it('additionne et soustrait', () => {
    const a = Money.fromCents(100);
    const b = Money.fromCents(250);
    expect(a.add(b).cents).toBe(350);
    expect(b.subtract(a).cents).toBe(150);
  });

  it('compare les montants', () => {
    expect(Money.fromCents(100).equals(Money.fromCents(100))).toBe(true);
    expect(Money.fromCents(100).isPositive()).toBe(true);
    expect(Money.fromCents(-5).isNegative()).toBe(true);
    expect(Money.zero().isZero()).toBe(true);
  });

  it('répartit un montant en N parts égales sans perdre de centime', () => {
    // 100 centimes en 3 parts : 34 + 33 + 33
    const parts = Money.fromCents(100).splitEqually(3);
    expect(parts.map((p) => p.cents)).toEqual([34, 33, 33]);
    expect(parts.reduce((s, p) => s + p.cents, 0)).toBe(100);
  });

  it('répartit un montant au prorata de poids sans perdre de centime', () => {
    // 1000 centimes, poids [1, 1, 1] → 334, 333, 333
    const parts = Money.fromCents(1000).splitByWeights([1, 1, 1]);
    expect(parts.reduce((s, p) => s + p.cents, 0)).toBe(1000);

    // poids [3, 1] → 750 / 250
    const p2 = Money.fromCents(1000).splitByWeights([3, 1]);
    expect(p2.map((p) => p.cents)).toEqual([750, 250]);
  });

  it('refuse une répartition avec poids total nul ou négatif', () => {
    expect(() => Money.fromCents(100).splitByWeights([0, 0])).toThrow();
    expect(() => Money.fromCents(100).splitByWeights([-1, 2])).toThrow();
    expect(() => Money.fromCents(100).splitEqually(0)).toThrow();
  });

  it('affiche en euros', () => {
    expect(Money.fromCents(1250).toEuros()).toBe(12.5);
  });
});
