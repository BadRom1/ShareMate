import { describe, expect, it } from 'vitest';
import { Thread } from './thread.js';
import { DomainError } from '../shared/domain-error.js';

const base = {
  id: 't1',
  equipmentId: 'e1',
  authorId: 'u1',
  createdAt: new Date('2026-01-01T10:00:00Z'),
};

describe('Thread', () => {
  it('crée un fil et aligne updatedAt sur createdAt par défaut', () => {
    const thread = Thread.create({ ...base, title: '  Panne moteur  ' });
    expect(thread.title).toBe('Panne moteur');
    expect(thread.updatedAt).toEqual(thread.createdAt);
  });

  it('refuse un titre vide', () => {
    expect(() => Thread.create({ ...base, title: '  ' })).toThrow(DomainError);
  });

  it('rename change le titre et met à jour updatedAt', () => {
    const thread = Thread.create({ ...base, title: 'Ancien' });
    const renamed = thread.rename('Nouveau', new Date('2026-01-03T10:00:00Z'));
    expect(renamed.title).toBe('Nouveau');
    expect(renamed.updatedAt).toEqual(new Date('2026-01-03T10:00:00Z'));
  });
});
