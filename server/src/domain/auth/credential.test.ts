import { describe, expect, it } from 'vitest';
import { MemberCredential } from './credential.js';
import { DomainError } from '../shared/domain-error.js';

describe('MemberCredential', () => {
  it('refuse un accès sans mot de passe ni invitation', () => {
    expect(() => MemberCredential.create({ memberId: 'm1' })).toThrow(DomainError);
  });

  it('accepte une invitation en attente', () => {
    const credential = MemberCredential.create({ memberId: 'm1', inviteCode: 'code' });
    expect(credential.hasPassword).toBe(false);
    expect(credential.inviteCode).toBe('code');
  });

  it('withPassword pose le hash et consomme l’invitation', () => {
    const credential = MemberCredential.create({ memberId: 'm1', inviteCode: 'code' }).withPassword('hash');
    expect(credential.hasPassword).toBe(true);
    expect(credential.passwordHash).toBe('hash');
    expect(credential.inviteCode).toBeNull();
    expect(credential.inviteExpiresAt).toBeNull();
  });

  it('withInvite conserve le mot de passe existant et pose l’échéance', () => {
    const expiresAt = new Date('2026-07-09T10:00:00Z');
    const credential = MemberCredential.create({ memberId: 'm1', passwordHash: 'hash' }).withInvite(
      'nouveau',
      expiresAt,
    );
    expect(credential.passwordHash).toBe('hash');
    expect(credential.inviteCode).toBe('nouveau');
    expect(credential.inviteExpiresAt).toEqual(expiresAt);
  });

  describe('validité d’une invitation', () => {
    const maintenant = new Date('2026-07-02T10:00:00Z');

    it('vaut jusqu’à son échéance, pas au-delà', () => {
      const credential = MemberCredential.create({
        memberId: 'm1',
        inviteCode: 'code',
        inviteExpiresAt: new Date('2026-07-09T10:00:00Z'),
      });
      expect(credential.isInviteValid(maintenant)).toBe(true);
      expect(credential.isInviteValid(new Date('2026-07-09T10:00:01Z'))).toBe(false);
    });

    it('un code sans échéance est tenu pour périmé (rangée antérieure à l’expiration)', () => {
      const credential = MemberCredential.create({ memberId: 'm1', inviteCode: 'code' });
      expect(credential.isInviteValid(maintenant)).toBe(false);
    });

    it('un accès sans invitation n’est jamais valide', () => {
      const credential = MemberCredential.create({ memberId: 'm1', passwordHash: 'hash' });
      expect(credential.isInviteValid(maintenant)).toBe(false);
    });
  });
});
