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

  it('n’est administrateur que si on le dit', () => {
    expect(Member.create({ id: 'm1', name: 'Alice' }).isAdmin).toBe(false);
    expect(Member.create({ id: 'm1', name: 'Alice', isAdmin: true }).isAdmin).toBe(true);
  });
});

describe('Member — changement d’identité', () => {
  const alice = Member.create({ id: 'm1', name: 'Alice', email: 'alice@example.org', invitedById: 'm0' });

  it('garde l’identifiant, l’invitant et le rôle', () => {
    const admin = Member.create({ id: 'm1', name: 'Alice', isAdmin: true, invitedById: 'm0' });
    const renommé = admin.withIdentity('Alice Dupont', 'a.dupont@example.org');
    expect(renommé.id).toBe('m1');
    expect(renommé.invitedById).toBe('m0');
    expect(renommé.isAdmin).toBe(true);
    expect(renommé.name).toBe('Alice Dupont');
    expect(renommé.email).toBe('a.dupont@example.org');
  });

  it('accepte de perdre l’email, refuse d’en prendre un invalide', () => {
    expect(alice.withIdentity('Alice', null).email).toBeNull();
    expect(() => alice.withIdentity('Alice', 'pas-une-adresse')).toThrow(DomainError);
    expect(() => alice.withIdentity('  ', null)).toThrow(DomainError);
  });
});
