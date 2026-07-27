import { describe, expect, it } from 'vitest';
import { assertValidDate, parseIsoDate } from './iso-date.js';
import { DomainError } from './domain-error.js';

describe('parseIsoDate', () => {
  it('accepte le jour seul comme l’instant complet', () => {
    expect(parseIsoDate('2026-07-02', 'La date').toISOString()).toBe('2026-07-02T00:00:00.000Z');
    expect(parseIsoDate('2026-07-02T08:30:00.000Z', 'La date').toISOString()).toBe('2026-07-02T08:30:00.000Z');
    expect(parseIsoDate('2024-02-29', 'La date').toISOString()).toBe('2024-02-29T00:00:00.000Z'); // année bissextile
  });

  it('refuse ce que `new Date` rend illisible, au lieu de le laisser casser à la sérialisation', () => {
    for (const absurde of ['0000-00-00', '9999-99-99', '2026-13-01']) {
      expect(() => parseIsoDate(absurde, 'La date'), absurde).toThrow(DomainError);
    }
  });

  it('refuse un jour qui n’existe pas, que `new Date` reporterait en silence', () => {
    // `new Date('2026-02-31')` rend le 3 mars : la date enregistrée ne serait pas celle saisie.
    for (const impossible of ['2026-02-31', '2026-04-31', '2025-02-29', '2026-02-31T10:00:00.000Z']) {
      expect(() => parseIsoDate(impossible, 'La date'), impossible).toThrow(DomainError);
    }
  });

  it('nomme le champ fautif dans le message', () => {
    expect(() => parseIsoDate('2026-02-31', "La date d'acquisition")).toThrow(/La date d’acquisition|d'acquisition/);
  });
});

describe('assertValidDate', () => {
  it('laisse passer une date valide et refuse une Invalid Date', () => {
    expect(() => assertValidDate(new Date('2026-07-02'), 'La date')).not.toThrow();
    expect(() => assertValidDate(new Date('n’importe quoi'), 'La date')).toThrow(DomainError);
  });
});
