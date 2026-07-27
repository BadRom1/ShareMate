import { describe, expect, it } from 'vitest';
import { Member } from './member.js';
import { DomainError } from '../shared/domain-error.js';

describe('Member', () => {
  it('exige un nom non vide, et le rogne', () => {
    expect(Member.create({ id: 'm1', name: '  Alice ' }).name).toBe('Alice');
    expect(() => Member.create({ id: 'm1', name: '   ' })).toThrow(DomainError);
  });

  it('accepte l’absence d’email, y compris sous forme de champ vide', () => {
    expect(Member.create({ id: 'm1', name: 'Alice' }).email).toBeNull();
    expect(Member.create({ id: 'm1', name: 'Alice', email: null }).email).toBeNull();
    // Un formulaire qui n'a pas été rempli ne vaut pas une adresse invalide.
    expect(Member.create({ id: 'm1', name: 'Alice', email: '  ' }).email).toBeNull();
  });

  it('rogne l’email conservé', () => {
    expect(Member.create({ id: 'm1', name: 'Alice', email: ' alice@example.org ' }).email).toBe('alice@example.org');
  });

  it('refuse un email mal formé : il sert d’identifiant de connexion', () => {
    for (const invalide of ['alice', 'alice@', '@example.org', 'alice@example', 'a b@example.org', 'a@b@c.org']) {
      expect(() => Member.create({ id: 'm1', name: 'Alice', email: invalide })).toThrow(DomainError);
    }
  });
});
