import { DomainError } from './domain-error.js';

/**
 * Montant monétaire en centimes (entier) — évite toute erreur d'arrondi flottant.
 */
export class Money {
  private constructor(readonly cents: number) {}

  static fromCents(cents: number): Money {
    if (!Number.isInteger(cents)) {
      throw new DomainError('Un montant doit être un nombre entier de centimes.');
    }
    return new Money(cents);
  }

  static fromEuros(euros: number): Money {
    if (!Number.isFinite(euros)) {
      throw new DomainError('Montant invalide.');
    }
    // toFixed(4) neutralise le bruit flottant (ex. 10.005 * 100 = 1000.4999…).
    return new Money(Math.round(Number((euros * 100).toFixed(4))));
  }

  static zero(): Money {
    return new Money(0);
  }

  add(other: Money): Money {
    return new Money(this.cents + other.cents);
  }

  subtract(other: Money): Money {
    return new Money(this.cents - other.cents);
  }

  negate(): Money {
    return new Money(-this.cents);
  }

  equals(other: Money): boolean {
    return this.cents === other.cents;
  }

  isPositive(): boolean {
    return this.cents > 0;
  }

  isNegative(): boolean {
    return this.cents < 0;
  }

  isZero(): boolean {
    return this.cents === 0;
  }

  toEuros(): number {
    return this.cents / 100;
  }

  /**
   * Répartition en N parts égales ; les centimes de reste sont distribués
   * aux premières parts pour que la somme des parts égale le montant initial.
   */
  splitEqually(count: number): Money[] {
    if (!Number.isInteger(count) || count <= 0) {
      throw new DomainError('Le nombre de parts doit être un entier positif.');
    }
    return this.splitByWeights(new Array<number>(count).fill(1));
  }

  /**
   * Répartition au prorata de poids (ex. temps d'usage). La somme des parts
   * égale exactement le montant initial (méthode des plus forts restes).
   */
  splitByWeights(weights: number[]): Money[] {
    if (weights.length === 0) {
      throw new DomainError('Au moins un poids est requis.');
    }
    if (weights.some((w) => w < 0 || !Number.isFinite(w))) {
      throw new DomainError('Les poids doivent être des nombres positifs.');
    }
    const total = weights.reduce((s, w) => s + w, 0);
    if (total <= 0) {
      throw new DomainError('La somme des poids doit être strictement positive.');
    }

    const raw = weights.map((w) => (this.cents * w) / total);
    const floored = raw.map((r) => Math.floor(r));
    let remainder = this.cents - floored.reduce((s, f) => s + f, 0);

    // Distribue le reste aux plus forts restes (ordre stable en cas d'égalité).
    const order = raw
      .map((r, i) => ({ i, frac: r - Math.floor(r) }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i);
    const result = [...floored];
    for (const { i } of order) {
      if (remainder <= 0) break;
      result[i] = (result[i] ?? 0) + 1;
      remainder -= 1;
    }
    return result.map((c) => new Money(c));
  }
}
