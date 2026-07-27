import { describe, expect, it } from 'vitest';
import { Checklist } from './checklist.js';
import { DomainError } from '../shared/domain-error.js';

function make(title = 'Avant utilisation') {
  return Checklist.create({
    id: 'c1',
    equipmentId: 'e1',
    authorId: 'm1',
    title,
    createdAt: new Date('2026-07-01T08:00:00Z'),
  });
}

describe('Checklist', () => {
  it('normalise le titre et cale updatedAt sur createdAt', () => {
    const checklist = make('  Avant utilisation  ');
    expect(checklist.title).toBe('Avant utilisation');
    expect(checklist.updatedAt).toEqual(checklist.createdAt);
  });

  it('refuse un titre vide ou trop long', () => {
    expect(() => make('   ')).toThrow(DomainError);
    expect(() => make('x'.repeat(201))).toThrow(DomainError);
  });

  it('renomme et horodate la dernière activité', () => {
    const at = new Date('2026-07-02T09:00:00Z');
    const renamed = make().rename('Hivernage', at);
    expect(renamed.title).toBe('Hivernage');
    expect(renamed.updatedAt).toEqual(at);
    expect(renamed.createdAt).toEqual(make().createdAt);
  });

  it('marque une activité sans changer le titre', () => {
    const at = new Date('2026-07-03T09:00:00Z');
    const touched = make().touch(at);
    expect(touched.title).toBe('Avant utilisation');
    expect(touched.updatedAt).toEqual(at);
  });
});
