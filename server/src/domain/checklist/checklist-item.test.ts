import { describe, expect, it } from 'vitest';
import { ChecklistItem } from './checklist-item.js';
import { DomainError } from '../shared/domain-error.js';

function make(label = 'Vérifier le niveau d’huile', position = 0) {
  return ChecklistItem.create({ id: 'i1', checklistId: 'c1', label, position });
}

describe('ChecklistItem', () => {
  it('naît non coché, libellé normalisé', () => {
    const item = make('  Vérifier le niveau d’huile  ');
    expect(item.label).toBe('Vérifier le niveau d’huile');
    expect(item.isChecked).toBe(false);
    expect(item.checkedAt).toBeNull();
    expect(item.checkedById).toBeNull();
  });

  it('refuse un libellé vide ou trop long', () => {
    expect(() => make('  ')).toThrow(DomainError);
    expect(() => make('x'.repeat(201))).toThrow(DomainError);
  });

  it('refuse une position non entière ou négative', () => {
    expect(() => make('ok', -1)).toThrow(DomainError);
    expect(() => make('ok', 1.5)).toThrow(DomainError);
  });

  it('refuse une coche incomplète (auteur sans date, ou inverse)', () => {
    expect(() =>
      ChecklistItem.create({ id: 'i1', checklistId: 'c1', label: 'ok', position: 0, checkedById: 'm1' }),
    ).toThrow(DomainError);
    expect(() =>
      ChecklistItem.create({ id: 'i1', checklistId: 'c1', label: 'ok', position: 0, checkedAt: new Date() }),
    ).toThrow(DomainError);
  });

  it('coche, recoche au nom d’un autre membre, puis décoche', () => {
    const at = new Date('2026-07-02T10:00:00Z');
    const checked = make().check('m1', at);
    expect(checked.isChecked).toBe(true);
    expect(checked.checkedById).toBe('m1');
    expect(checked.checkedAt).toEqual(at);

    const later = new Date('2026-07-02T11:00:00Z');
    const recheck = checked.check('m2', later);
    expect(recheck.checkedById).toBe('m2');
    expect(recheck.checkedAt).toEqual(later);

    const unchecked = recheck.uncheck();
    expect(unchecked.isChecked).toBe(false);
    expect(unchecked.checkedById).toBeNull();
  });

  it('change le libellé sans perdre la coche', () => {
    const checked = make().check('m1', new Date('2026-07-02T10:00:00Z'));
    const renamed = checked.relabel('Contrôler le niveau d’huile');
    expect(renamed.label).toBe('Contrôler le niveau d’huile');
    expect(renamed.isChecked).toBe(true);
    expect(renamed.checkedById).toBe('m1');
  });
});
