import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth-service.js';
import { makeFixture } from './testing/fixture.js';
import { ConflictError, DomainError, NotFoundError, UnauthorizedError } from '../domain/shared/domain-error.js';

let service: AuthService;
let fixture: Awaited<ReturnType<typeof makeFixture>>;

beforeEach(async () => {
  fixture = await makeFixture();
  service = new AuthService(
    fixture.members,
    fixture.credentials,
    fixture.sessions,
    fixture.hasher,
    fixture.tokens,
    fixture.idGenerator,
    fixture.clock,
  );
});

describe('AuthService — bootstrap', () => {
  it('crée le premier compte et ouvre une session', async () => {
    expect(await service.needsBootstrap()).toBe(true);
    const { member, session } = await service.bootstrap({ name: 'Romain', password: 'motdepasse' });
    expect(await service.needsBootstrap()).toBe(false);
    expect((await service.authenticate(session.token))?.id).toBe(member.id);
  });

  it('refuse un second bootstrap', async () => {
    await service.bootstrap({ name: 'Romain', password: 'motdepasse' });
    await expect(service.bootstrap({ name: 'Intrus', password: 'motdepasse' })).rejects.toThrow(ConflictError);
  });

  it('refuse un mot de passe trop court', async () => {
    await expect(service.bootstrap({ name: 'Romain', password: 'court' })).rejects.toThrow(DomainError);
  });
});

describe('AuthService — invitations', () => {
  it('création de membre avec code, puis redeem = mot de passe posé et session ouverte', async () => {
    const { member, inviteCode } = await service.createMemberWithInvite({ name: 'Bruno' });
    expect((await service.inviteInfo(inviteCode)).id).toBe(member.id);

    const { session } = await service.redeemInvite(inviteCode, 'secretbruno');
    expect((await service.authenticate(session.token))?.id).toBe(member.id);

    // Le code est consommé
    await expect(service.inviteInfo(inviteCode)).rejects.toThrow(NotFoundError);
    await expect(service.redeemInvite(inviteCode, 'autreessai')).rejects.toThrow(NotFoundError);
  });

  it('régénère une invitation sans casser le mot de passe existant', async () => {
    const { inviteCode } = await service.createMemberWithInvite({ name: 'Bruno' });
    const { member } = await service.redeemInvite(inviteCode, 'secretbruno');

    const newCode = await service.regenerateInvite(member.id);
    await service.login('Bruno', 'secretbruno'); // l'ancien mot de passe marche toujours
    await service.redeemInvite(newCode, 'nouveausecret');
    await expect(service.login('Bruno', 'secretbruno')).rejects.toThrow(UnauthorizedError);
    await service.login('Bruno', 'nouveausecret');
  });

  it('régénérer pour un membre inconnu échoue', async () => {
    await expect(service.regenerateInvite('fantome')).rejects.toThrow(NotFoundError);
  });
});

describe('AuthService — login et sessions', () => {
  beforeEach(async () => {
    const { inviteCode } = await service.createMemberWithInvite({ name: 'Bruno', email: 'bruno@example.org' });
    await service.redeemInvite(inviteCode, 'secretbruno');
  });

  it('connexion par nom ou email, insensible à la casse', async () => {
    await service.login('bruno', 'secretbruno');
    await service.login('BRUNO@example.org', 'secretbruno');
  });

  it('mauvais mot de passe ou inconnu → UnauthorizedError', async () => {
    await expect(service.login('Bruno', 'mauvais')).rejects.toThrow(UnauthorizedError);
    await expect(service.login('Personne', 'secretbruno')).rejects.toThrow(UnauthorizedError);
  });

  it('un membre sans mot de passe (invitation en attente) ne peut pas se connecter', async () => {
    await service.createMemberWithInvite({ name: 'Chloé' });
    await expect(service.login('Chloé', 'nimporte')).rejects.toThrow(UnauthorizedError);
  });

  it('logout invalide la session', async () => {
    const { session } = await service.login('Bruno', 'secretbruno');
    await service.logout(session.token);
    expect(await service.authenticate(session.token)).toBeNull();
  });

  it('une session expirée est refusée', async () => {
    const { session } = await service.login('Bruno', 'secretbruno');
    fixture.clock.set(new Date('2026-08-15T10:00:00Z')); // > 30 jours
    expect(await service.authenticate(session.token)).toBeNull();
  });

  it('un jeton forgé est refusé', async () => {
    expect(await service.authenticate('jeton-invente')).toBeNull();
  });

  it('changement de mot de passe : vérifie l’actuel', async () => {
    const { member } = await service.login('Bruno', 'secretbruno');
    await expect(service.changePassword(member.id, 'mauvais', 'nouveausecret')).rejects.toThrow(UnauthorizedError);
    await service.changePassword(member.id, 'secretbruno', 'nouveausecret');
    await service.login('Bruno', 'nouveausecret');
  });
});
