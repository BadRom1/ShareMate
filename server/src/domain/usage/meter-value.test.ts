import { describe, expect, it } from 'vitest';
import { roundMeterValue } from './meter-value.js';

describe('roundMeterValue', () => {
  it('efface le bruit flottant des sommes et différences de compteurs', () => {
    expect(roundMeterValue(164 + 1.3 - 164)).toBe(1.3);
    expect(roundMeterValue(0.1 + 0.2)).toBe(0.3);
  });

  it('conserve les valeurs déjà nettes', () => {
    expect(roundMeterValue(165.3)).toBe(165.3);
    expect(roundMeterValue(1200)).toBe(1200);
    expect(roundMeterValue(0)).toBe(0);
  });

  it('arrondit au centième', () => {
    expect(roundMeterValue(1.235)).toBe(1.24);
    expect(roundMeterValue(1.2349)).toBe(1.23);
  });

  it('laisse passer les valeurs non finies (la validation métier les rejette)', () => {
    expect(roundMeterValue(Number.NaN)).toBeNaN();
    expect(roundMeterValue(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});
