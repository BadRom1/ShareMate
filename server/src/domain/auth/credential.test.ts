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

  it('withReset conserve le mot de passe et pose un code de reprise daté', () => {
    const expiresAt = new Date('2026-07-03T10:00:00Z');
    const credential = MemberCredential.create({ memberId: 'm1', passwordHash: 'hash' }).withReset('repris', expiresAt);
    expect(credential.passwordHash).toBe('hash');
    expect(credential.resetCode).toBe('repris');
    expect(credential.resetExpiresAt).toEqual(expiresAt);
  });

  it('withPassword consomme aussi la réinitialisation', () => {
    const credential = MemberCredential.create({ memberId: 'm1', passwordHash: 'ancien' })
      .withReset('repris', new Date('2026-07-03T10:00:00Z'))
      .withPassword('nouveau');
    expect(credential.passwordHash).toBe('nouveau');
    expect(credential.resetCode).toBeNull();
    expect(credential.resetExpiresAt).toBeNull();
  });

  describe('validité d’une réinitialisation', () => {
    const maintenant = new Date('2026-07-02T10:00:00Z');

    it('vaut jusqu’à son échéance, pas au-delà', () => {
      const credential = MemberCredential.create({ memberId: 'm1', passwordHash: 'hash' }).withReset(
        'repris',
        new Date('2026-07-03T10:00:00Z'),
      );
      expect(credential.isResetValid(maintenant)).toBe(true);
      expect(credential.isResetValid(new Date('2026-07-03T10:00:01Z'))).toBe(false);
    });

    it('ne vaut pas sur un compte jamais ouvert : celui-là relève de l’invitation', () => {
      // État qu'aucun service ne produit, et que la relecture d'une rangée pourrait rendre :
      // un code de reprise sans mot de passe à remplacer ne doit rien ouvrir.
      const credential = MemberCredential.create({
        memberId: 'm1',
        inviteCode: 'invitation',
        resetCode: 'repris',
        resetExpiresAt: new Date('2026-07-03T10:00:00Z'),
      });
      expect(credential.isResetValid(maintenant)).toBe(false);
    });

    it('un code sans échéance ne vaut pas davantage', () => {
      const credential = MemberCredential.create({ memberId: 'm1', passwordHash: 'hash', resetCode: 'repris' });
      expect(credential.isResetValid(maintenant)).toBe(false);
    });

    it('un accès sans réinitialisation n’est jamais valide', () => {
      const credential = MemberCredential.create({ memberId: 'm1', passwordHash: 'hash' });
      expect(credential.isResetValid(maintenant)).toBe(false);
    });
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
