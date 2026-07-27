import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth-service.js';
import { makeFixture } from './testing/fixture.js';
import { FakePasswordHasher } from './testing/in-memory.js';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../domain/shared/domain-error.js';

/**
 * Compte les dérivations de clé. `hash` et `verify` coûtent la même chose en scrypt : le nombre
 * de dérivations est donc une mesure fidèle du temps de réponse observable de l'extérieur.
 */
class HasherCompteur extends FakePasswordHasher {
  dérivations = 0;
  override async hash(password: string) {
    this.dérivations += 1;
    return super.hash(password);
  }
  override async verify(password: string, hash: string) {
    this.dérivations += 1;
    return super.verify(password, hash);
  }
}

let service: AuthService;
let hasher: HasherCompteur;
let fixture: Awaited<ReturnType<typeof makeFixture>>;

beforeEach(async () => {
  fixture = await makeFixture();
  hasher = new HasherCompteur();
  service = new AuthService(
    fixture.members,
    fixture.credentials,
    fixture.sessions,
    fixture.equipments,
    hasher,
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

  it('deux bootstraps concurrents ne créent qu’un seul premier compte', async () => {
    // Les deux appels lisent `needsBootstrap` avant que l'autre n'ait écrit : seule l'écriture
    // conditionnelle (`saveFirst`) départage.
    const résultats = await Promise.allSettled([
      service.bootstrap({ name: 'Romain', password: 'motdepasse' }),
      service.bootstrap({ name: 'Intrus', password: 'motdepasse' }),
    ]);
    expect(résultats.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(résultats.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await fixture.credentials.count()).toBe(1);

    // Le compte perdant n'ouvre aucun accès : un seul des deux noms peut se connecter.
    const connexions = await Promise.allSettled([
      service.login('Romain', 'motdepasse'),
      service.login('Intrus', 'motdepasse'),
    ]);
    expect(connexions.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('refuse un mot de passe trop court', async () => {
    await expect(service.bootstrap({ name: 'Romain', password: 'court' })).rejects.toThrow(DomainError);
  });
});

describe('AuthService — invitations', () => {
  it('création de membre avec code, puis redeem = mot de passe posé et session ouverte', async () => {
    const { member, inviteCode } = await service.createMemberWithInvite({ name: 'Bruno' }, 'm1');
    expect((await service.inviteInfo(inviteCode)).id).toBe(member.id);

    const { session } = await service.redeemInvite(inviteCode, 'secretbruno');
    expect((await service.authenticate(session.token))?.id).toBe(member.id);

    // Le code est consommé
    await expect(service.inviteInfo(inviteCode)).rejects.toThrow(NotFoundError);
    await expect(service.redeemInvite(inviteCode, 'autreessai')).rejects.toThrow(NotFoundError);
  });

  it('une invitation ne réécrit jamais un mot de passe existant', async () => {
    // État que produisaient les versions antérieures : un code posé sur un compte déjà ouvert.
    const { member, inviteCode } = await service.createMemberWithInvite({ name: 'Bruno' }, 'm1');
    await service.redeemInvite(inviteCode, 'secretbruno');
    const piégé = 'code-recyclé';
    const ouvert = (await fixture.credentials.findByMemberId(member.id))!;
    await fixture.credentials.save(ouvert.withInvite(piégé, new Date('2026-07-09T10:00:00Z')));

    await expect(service.inviteInfo(piégé)).rejects.toThrow(ConflictError);
    await expect(service.redeemInvite(piégé, 'volé')).rejects.toThrow(ConflictError);
    await service.login('Bruno', 'secretbruno'); // le mot de passe du titulaire est intact
  });

  it('régénérer une invitation exige de partager le périmètre du demandeur', async () => {
    // m1/m2 partagent la minipelle ; m3 est en dehors.
    await expect(service.regenerateInvite('m2', 'm1')).resolves.toBeTypeOf('string');
    await expect(service.regenerateInvite('m1', 'm1')).resolves.toBeTypeOf('string');
    await expect(service.regenerateInvite('m3', 'm1')).rejects.toThrow(ForbiddenError);
    await expect(service.regenerateInvite('m1', 'm3')).rejects.toThrow(ForbiddenError);
  });

  it('un membre invité reste joignable par son invitant avant tout cercle commun', async () => {
    const { member } = await service.createMemberWithInvite({ name: 'Denis' }, 'm3');
    await expect(service.regenerateInvite(member.id, 'm3')).resolves.toBeTypeOf('string');
    await expect(service.regenerateInvite(member.id, 'm1')).rejects.toThrow(ForbiddenError);
  });

  it('régénérer sur un compte déjà ouvert est refusé (l’invitation n’est pas une réinitialisation)', async () => {
    const { member, inviteCode } = await service.createMemberWithInvite({ name: 'Bruno' }, 'm1');
    await service.redeemInvite(inviteCode, 'secretbruno');
    await expect(service.regenerateInvite(member.id, 'm1')).rejects.toThrow(ConflictError);
    await service.login('Bruno', 'secretbruno');
  });

  it('un code non consommé expire au bout de 7 jours', async () => {
    const { inviteCode } = await service.createMemberWithInvite({ name: 'Bruno' }, 'm1');
    fixture.clock.set(new Date('2026-07-09T10:00:01Z')); // création + 7 jours + 1 s
    await expect(service.inviteInfo(inviteCode)).rejects.toThrow(NotFoundError);
    await expect(service.redeemInvite(inviteCode, 'secretbruno')).rejects.toThrow(NotFoundError);
  });

  it('régénérer repart d’une échéance neuve', async () => {
    const { member } = await service.createMemberWithInvite({ name: 'Bruno' }, 'm1');
    fixture.clock.set(new Date('2026-07-08T10:00:00Z'));
    const code = await service.regenerateInvite(member.id, 'm1');
    fixture.clock.set(new Date('2026-07-14T10:00:00Z'));
    expect((await service.inviteInfo(code)).id).toBe(member.id);
  });

  it('régénérer pour un membre inconnu échoue, du même message qu’un membre hors périmètre', async () => {
    const inconnu = service.regenerateInvite('fantome', 'm1');
    await expect(inconnu).rejects.toThrow(NotFoundError);
    await expect(inconnu).rejects.toThrow('Membre introuvable : fantome');
    await expect(service.regenerateInvite('m3', 'm1')).rejects.toThrow('Membre introuvable : m3');
  });
});

describe('AuthService — login et sessions', () => {
  beforeEach(async () => {
    const { inviteCode } = await service.createMemberWithInvite({ name: 'Bruno', email: 'bruno@example.org' }, 'm1');
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
    await service.createMemberWithInvite({ name: 'Chloé' }, 'm1');
    await expect(service.login('Chloé', 'nimporte')).rejects.toThrow(UnauthorizedError);
  });

  it('un échec coûte une dérivation de clé, que l’identifiant existe ou non', async () => {
    // Sans ce leurre, un refus instantané signalerait « ce compte n'existe pas » quel que soit
    // le message renvoyé : le temps de réponse suffirait à énumérer les comptes.
    hasher.dérivations = 0;
    await expect(service.login('Bruno', 'mauvais')).rejects.toThrow(UnauthorizedError);
    expect(hasher.dérivations).toBe(1);

    hasher.dérivations = 0;
    await expect(service.login('Personne', 'mauvais')).rejects.toThrow(UnauthorizedError);
    expect(hasher.dérivations).toBe(1);

    // Invitation en attente : le compte existe mais n'a pas de hachage à comparer.
    hasher.dérivations = 0;
    await service.createMemberWithInvite({ name: 'Chloé' }, 'm1');
    await expect(service.login('Chloé', 'mauvais')).rejects.toThrow(UnauthorizedError);
    expect(hasher.dérivations).toBe(1);
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

  it('changer de mot de passe révoque les autres sessions et en rouvre une', async () => {
    const { member, session: ancienne } = await service.login('Bruno', 'secretbruno');
    const { session: autreAppareil } = await service.login('Bruno', 'secretbruno');

    const nouvelle = await service.changePassword(member.id, 'secretbruno', 'nouveausecret');

    expect(await service.authenticate(ancienne.token)).toBeNull();
    expect(await service.authenticate(autreAppareil.token)).toBeNull();
    expect((await service.authenticate(nouvelle.token))?.id).toBe(member.id);
  });

  it('consommer une invitation révoque les sessions antérieures du compte', async () => {
    const { member, inviteCode } = await service.createMemberWithInvite({ name: 'Chloé' }, 'm1');
    // Session ouverte sur le compte avant qu'il ne soit revendiqué (appareil prêté).
    await fixture.sessions.save({
      tokenHash: 'hash(vieux-jeton)',
      memberId: member.id,
      expiresAt: new Date('2026-08-01T10:00:00Z'),
    });

    const { session } = await service.redeemInvite(inviteCode, 'secretchloe');

    expect(await service.authenticate('vieux-jeton')).toBeNull();
    expect((await service.authenticate(session.token))?.id).toBe(member.id);
  });
});
