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
  });

  it('withInvite conserve le mot de passe existant', () => {
    const credential = MemberCredential.create({ memberId: 'm1', passwordHash: 'hash' }).withInvite('nouveau');
    expect(credential.passwordHash).toBe('hash');
    expect(credential.inviteCode).toBe('nouveau');
  });
});
