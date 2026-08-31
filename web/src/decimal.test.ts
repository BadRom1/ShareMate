import { describe, expect, it } from 'vitest';
import { decimalInputValue, isDecimalDraft, parseDecimal } from './decimal';

describe('parseDecimal', () => {
  it('lit la virgule comme le point', () => {
    expect(parseDecimal('1,3')).toBe(1.3);
    expect(parseDecimal('1.3')).toBe(1.3);
    expect(parseDecimal(' 165,3 ')).toBe(165.3);
    expect(parseDecimal('12')).toBe(12);
  });

  it('rend null sur un champ vide ou inexploitable', () => {
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('   ')).toBeNull();
    expect(parseDecimal(',')).toBeNull();
    expect(parseDecimal('abc')).toBeNull();
  });
});

describe('isDecimalDraft', () => {
  it('laisse frapper un nombre décimal, séparateur en cours de saisie compris', () => {
    for (const draft of ['', '1', '1,', '1,3', '1.3', ',5', '0,25']) {
      expect(isDecimalDraft(draft)).toBe(true);
    }
  });

  it('refuse ce qui n’est pas un nombre', () => {
    for (const draft of ['1,3,5', '-2', 'abc', '1 3', '1e3']) {
      expect(isDecimalDraft(draft)).toBe(false);
    }
  });
});

describe('decimalInputValue', () => {
  it('pré-remplit à la française, sans séparateur de milliers', () => {
    expect(decimalInputValue(165.3)).toBe('165,3');
    expect(decimalInputValue(1200)).toBe('1200');
  });
});
