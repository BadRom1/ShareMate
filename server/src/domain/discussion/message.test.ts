import { describe, expect, it } from 'vitest';
import { Message } from './message.js';
import { DomainError } from '../shared/domain-error.js';

const base = {
  id: 'm1',
  equipmentId: 'e1',
  authorId: 'u1',
  createdAt: new Date('2026-01-01T10:00:00Z'),
};

describe('Message', () => {
  it('normalise le corps (trim) et pose editedAt à null par défaut', () => {
    const message = Message.create({ ...base, body: '  Bonjour  ' });
    expect(message.body).toBe('Bonjour');
    expect(message.editedAt).toBeNull();
  });

  it('refuse un corps vide', () => {
    expect(() => Message.create({ ...base, body: '   ' })).toThrow(DomainError);
  });

  it('refuse un corps trop long', () => {
    expect(() => Message.create({ ...base, body: 'x'.repeat(4001) })).toThrow(DomainError);
  });
});
