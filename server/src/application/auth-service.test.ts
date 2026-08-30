import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth-service.js';
import { makeFixture } from './testing/fixture.js';
import { FakePasswordHasher, RecordingAuditLogger } from './testing/in-memory.js';
import {
  AuthorizationError,
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../domain/shared/domain-error.js';
import { Member } from '../domain/member/member.js';

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
let audit: RecordingAuditLogger;
let fixture: Awaited<ReturnType<typeof makeFixture>>;

beforeEach(async () => {
  fixture = await makeFixture();
  hasher = new HasherCompteur();
  audit = new RecordingAuditLogger();
  service = new AuthService(
    fixture.members,
    fixture.credentials,
    fixture.sessions,
    fixture.equipments,
    hasher,
    fixture.tokens,
    fixture.idGenerator,
    fixture.clock,
    audit,
  );
});

describe('AuthService — bootstrap', () => {
  it('crée le premier compte et ouvre une session', async () => {
    expect(await service.needsBootstrap()).toBe(true);
    const { member, session } = await service.bootstrap({ name: 'Romain', password: 'motdepasse' });
    expect(await service.needsBootstrap()).toBe(false);
    expect((await service.authenticate(session.token))?.member.id).toBe(member.id);
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

  it('fait du premier compte l’administrateur de l’instance', async () => {
    const { member } = await service.bootstrap({ name: 'Romain', password: 'motdepasse' });
    expect(member.isAdmin).toBe(true);
    expect((await fixture.members.findById(member.id))?.isAdmin).toBe(true);

    // Les comptes suivants ne le sont pas : le rôle n'est pas héréditaire.
    const { member: invité } = await service.createMemberWithInvite({ name: 'Bruno' }, member.id);
    expect((await fixture.members.findById(invité.id))?.isAdmin).toBe(false);
  });

  it('ne laisse pas le rôle au perdant d’un bootstrap concurrent', async () => {
    // Le compte du perdant reste en base sans accès. Marqué administrateur, il porterait le droit
    // d'absorber n'importe quel compte le jour où un accès lui serait rendu.
    await Promise.allSettled([
      service.bootstrap({ name: 'Romain', password: 'motdepasse' }),
      service.bootstrap({ name: 'Intrus', password: 'motdepasse' }),
    ]);
    const administrateurs = (await fixture.members.findAll()).filter((m) => m.isAdmin);
    expect(administrateurs).toHaveLength(1);
    // C'est bien celui qui peut se connecter.
    await expect(service.login(administrateurs[0]!.name, 'motdepasse')).resolves.toBeDefined();
  });
});

describe('AuthService — invitations', () => {
  it('création de membre avec code, puis redeem = mot de passe posé et session ouverte', async () => {
    const { member, inviteCode } = await service.createMemberWithInvite({ name: 'Bruno' }, 'm1');
    expect((await service.inviteInfo(inviteCode)).id).toBe(member.id);

    const { session } = await service.redeemInvite(inviteCode, 'secretbruno');
    expect((await service.authenticate(session.token))?.member.id).toBe(member.id);

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

  it('refuse un email déjà porté par un membre du périmètre du demandeur', async () => {
    await service.createMemberWithInvite({ name: 'Denis', email: 'denis@example.org' }, 'm1');
    // L'email est un identifiant de connexion : deux titulaires, et `login` en choisit un au hasard.
    await expect(service.createMemberWithInvite({ name: 'Autre', email: 'DENIS@example.org' }, 'm1')).rejects.toThrow(
      ConflictError,
    );
    await expect(
      service.createMemberWithInvite({ name: 'Autre', email: 'autre@example.org' }, 'm1'),
    ).resolves.toBeDefined();
  });

  it("n'apprend pas au demandeur qu'une adresse hors de son périmètre existe", async () => {
    await service.createMemberWithInvite({ name: 'Denis', email: 'denis@example.org' }, 'm1');
    // m3 ne partage aucun cercle avec Denis et ne l'a pas invité. Un refus distinctif ferait de
    // cette route un oracle : adresse par adresse, il énumérerait les comptes de l'instance —
    // exactement le canal que le cadrage de l'annuaire referme.
    await expect(
      service.createMemberWithInvite({ name: 'sonde', email: 'DENIS@example.org' }, 'm3'),
    ).resolves.toBeDefined();
  });

  it('régénérer une invitation est réservé au titulaire et à son invitant', async () => {
    // m1 a invité m2 et m3 ; m1/m2 partagent en outre la minipelle.
    await expect(service.regenerateInvite('m2', 'm1')).resolves.toBeTypeOf('string');
    await expect(service.regenerateInvite('m1', 'm1')).resolves.toBeTypeOf('string');
    await expect(service.regenerateInvite('m1', 'm3')).rejects.toThrow(ForbiddenError);
  });

  it('partager un cercle ne donne pas le droit de reprendre un compte jamais ouvert', async () => {
    // m2 s'inscrit dans un équipement avec m3 : le cercle commun se fabrique à la demande, il ne
    // peut donc pas ouvrir la reprise d'un compte que m2 n'a pas invité.
    await fixture.equipments.save((await fixture.equipments.findById('e1'))!.update({ memberIds: ['m2', 'm3'] }));
    await expect(service.regenerateInvite('m3', 'm2')).rejects.toThrow(ForbiddenError);
    await expect(service.regenerateInvite('m3', 'm2')).rejects.toThrow('Membre introuvable : m3');
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
    await expect(service.regenerateInvite('m1', 'm2')).rejects.toThrow('Membre introuvable : m1');
  });
});

describe('AuthService — réinitialisation de mot de passe', () => {
  /** Compte ouvert de Bruno, invité par m1, et m1 promu administrateur de l'instance. */
  async function instance() {
    await fixture.members.save(Member.create({ id: 'm1', name: 'Alice', isAdmin: true }));
    const { member, inviteCode } = await service.createMemberWithInvite({ name: 'Bruno' }, 'm1');
    await service.redeemInvite(inviteCode, 'secretbruno');
    return member;
  }

  it('l’administrateur émet un lien, le membre choisit un nouveau mot de passe et est connecté', async () => {
    const bruno = await instance();
    const { resetCode, member } = await service.startPasswordReset(bruno.id, 'm1');
    expect(member.name).toBe('Bruno');
    expect((await service.resetInfo(resetCode)).id).toBe(bruno.id);

    const { session } = await service.redeemPasswordReset(resetCode, 'nouveaupass');
    expect((await service.authenticate(session.token))?.member.id).toBe(bruno.id);
    await expect(service.login('Bruno', 'nouveaupass')).resolves.toBeDefined();
    // L'ancien mot de passe ne vaut plus rien.
    await expect(service.login('Bruno', 'secretbruno')).rejects.toThrow(UnauthorizedError);
  });

  it('le code ne sert qu’une fois', async () => {
    const bruno = await instance();
    const { resetCode } = await service.startPasswordReset(bruno.id, 'm1');
    await service.redeemPasswordReset(resetCode, 'nouveaupass');
    await expect(service.resetInfo(resetCode)).rejects.toThrow(NotFoundError);
    await expect(service.redeemPasswordReset(resetCode, 'encoreunautre')).rejects.toThrow(NotFoundError);
  });

  it('expire au bout de 24 h', async () => {
    const bruno = await instance();
    const { resetCode } = await service.startPasswordReset(bruno.id, 'm1');
    fixture.clock.set(new Date('2026-07-03T10:00:01Z')); // émission + 24 h + 1 s
    await expect(service.resetInfo(resetCode)).rejects.toThrow(NotFoundError);
    await expect(service.redeemPasswordReset(resetCode, 'nouveaupass')).rejects.toThrow(NotFoundError);
    // Et le compte reste ouvert avec son mot de passe d'origine.
    await expect(service.login('Bruno', 'secretbruno')).resolves.toBeDefined();
  });

  it('émettre un lien ne révoque rien : le mot de passe et les sessions tiennent jusqu’à sa consommation', async () => {
    const bruno = await instance();
    const { session } = await service.login('Bruno', 'secretbruno');
    await service.startPasswordReset(bruno.id, 'm1');
    expect((await service.authenticate(session.token))?.member.id).toBe(bruno.id);
    await expect(service.login('Bruno', 'secretbruno')).resolves.toBeDefined();
  });

  it('la consommation révoque toutes les sessions du membre', async () => {
    // Le geste réflexe après une compromission : celui qui reprend son compte en expulse
    // l'appareil resté connecté.
    const bruno = await instance();
    const { session: ancienne } = await service.login('Bruno', 'secretbruno');
    const { resetCode } = await service.startPasswordReset(bruno.id, 'm1');
    const { session: neuve } = await service.redeemPasswordReset(resetCode, 'nouveaupass');
    expect(await service.authenticate(ancienne.token)).toBeNull();
    expect((await service.authenticate(neuve.token))?.member.id).toBe(bruno.id);
  });

  it('un nouveau lien remplace le précédent', async () => {
    const bruno = await instance();
    const { resetCode: premier } = await service.startPasswordReset(bruno.id, 'm1');
    const { resetCode: second } = await service.startPasswordReset(bruno.id, 'm1');
    await expect(service.resetInfo(premier)).rejects.toThrow(NotFoundError);
    expect((await service.resetInfo(second)).id).toBe(bruno.id);
  });

  it('réservé à l’administrateur : ni l’invitant, ni un membre du cercle, ni le titulaire', async () => {
    const bruno = await instance();
    // m2 partage la minipelle avec m1 ; m3 a été invité par m1 comme Bruno.
    for (const demandeur of [bruno.id, 'm2', 'm3']) {
      await expect(service.startPasswordReset(bruno.id, demandeur)).rejects.toThrow(AuthorizationError);
    }
    // Le refus parle du geste, jamais des comptes visés : il tombe avant même de les chercher.
    await expect(service.startPasswordReset('fantome', 'm2')).rejects.toThrow(AuthorizationError);
  });

  it('refuse un compte jamais ouvert : c’est un lien de première connexion qu’il lui faut', async () => {
    await fixture.members.save(Member.create({ id: 'm1', name: 'Alice', isAdmin: true }));
    const { member } = await service.createMemberWithInvite({ name: 'Denis' }, 'm1');
    await expect(service.startPasswordReset(member.id, 'm1')).rejects.toThrow(ConflictError);
  });

  it('refuse un membre inconnu', async () => {
    await instance();
    await expect(service.startPasswordReset('fantome', 'm1')).rejects.toThrow(NotFoundError);
  });

  it('un mot de passe trop court est refusé, et le code reste valable', async () => {
    const bruno = await instance();
    const { resetCode } = await service.startPasswordReset(bruno.id, 'm1');
    await expect(service.redeemPasswordReset(resetCode, 'court')).rejects.toThrow(DomainError);
    expect((await service.resetInfo(resetCode)).id).toBe(bruno.id);
  });

  it('le geste laisse une trace au journal des gestes sensibles', async () => {
    const bruno = await instance();
    await service.startPasswordReset(bruno.id, 'm1');
    expect(audit.entries).toEqual([
      {
        action: 'membre.reinitialisation-emise',
        actorId: 'm1',
        targetId: bruno.id,
        details: { targetName: 'Bruno' },
      },
    ]);
  });

  it('un code d’invitation ne s’exploite pas comme une réinitialisation, et réciproquement', async () => {
    const bruno = await instance();
    const { resetCode } = await service.startPasswordReset(bruno.id, 'm1');
    // Le code de reprise ne passe pas par la porte des invitations…
    await expect(service.inviteInfo(resetCode)).rejects.toThrow(NotFoundError);
    await expect(service.redeemInvite(resetCode, 'volé')).rejects.toThrow(NotFoundError);
    // …et une invitation en attente ne reprend pas un compte par celle des réinitialisations.
    const { inviteCode } = await service.createMemberWithInvite({ name: 'Denis' }, 'm1');
    await expect(service.resetInfo(inviteCode)).rejects.toThrow(NotFoundError);
    await expect(service.redeemPasswordReset(inviteCode, 'volé')).rejects.toThrow(NotFoundError);
    await service.login('Bruno', 'secretbruno'); // le mot de passe du titulaire est intact
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

  it('un hachage au coût périmé est refait à la connexion, sans changer le mot de passe', async () => {
    const bruno = (await fixture.members.findByNameOrEmail('bruno@example.org'))[0]!;
    const périmé = await fixture.credentials.findByMemberId(bruno.id);
    await fixture.credentials.save(périmé!.withPassword('ancien:secretbruno'));

    await service.login('Bruno', 'secretbruno');

    expect((await fixture.credentials.findByMemberId(bruno.id))?.passwordHash).toBe('plain:secretbruno');
    await service.login('Bruno', 'secretbruno'); // le mot de passe reste le même
  });

  it('un hachage au coût courant n’est pas réécrit à la connexion', async () => {
    const bruno = (await fixture.members.findByNameOrEmail('bruno@example.org'))[0]!;
    let écritures = 0;
    const save = fixture.credentials.save.bind(fixture.credentials);
    fixture.credentials.save = async (credential) => {
      écritures += 1;
      return save(credential);
    };

    await service.login('Bruno', 'secretbruno');

    expect(écritures).toBe(0);
    expect((await fixture.credentials.findByMemberId(bruno.id))?.passwordHash).toBe('plain:secretbruno');
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

  it('une requête sans jeton est refusée comme une autre', async () => {
    // L'absence de jeton se traite dans le service, pas chez l'appelant : sinon chaque adapter
    // rejouerait la garde, et c'est le porteur d'un jeton — donnée de l'appelant — qui déciderait
    // du chemin suivi.
    expect(await service.authenticate(undefined)).toBeNull();
    expect(await service.authenticate('')).toBeNull();
  });

  it('une session expirée est refusée', async () => {
    const { session } = await service.login('Bruno', 'secretbruno');
    fixture.clock.set(new Date('2026-08-15T10:00:00Z')); // > 30 jours
    expect(await service.authenticate(session.token)).toBeNull();
  });

  it('un jeton forgé est refusé', async () => {
    expect(await service.authenticate('jeton-invente')).toBeNull();
  });

  it('une session loin de son échéance n’est pas réécrite à chaque appel', async () => {
    const { session } = await service.login('Bruno', 'secretbruno');
    // Chaque prolongation est une transaction en écriture SQLite : à ce stade, elle n'apporte rien.
    fixture.clock.set(new Date('2026-07-12T10:00:00Z')); // +10 jours, il en reste 20
    expect(await service.authenticate(session.token)).not.toBeNull();
    expect((await fixture.sessions.findByTokenHash(`hash(${session.token})`))?.expiresAt).toEqual(session.expiresAt);
  });

  it('une session proche de son échéance est prolongée', async () => {
    const { session } = await service.login('Bruno', 'secretbruno');
    fixture.clock.set(new Date('2026-07-24T10:00:00Z')); // +22 jours, il en reste 8 (< 10)
    expect(await service.authenticate(session.token)).not.toBeNull();
    expect((await fixture.sessions.findByTokenHash(`hash(${session.token})`))?.expiresAt).toEqual(
      new Date('2026-08-23T10:00:00Z'),
    );
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
    expect((await service.authenticate(nouvelle.token))?.member.id).toBe(member.id);
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
    expect((await service.authenticate(session.token))?.member.id).toBe(member.id);
  });
});
