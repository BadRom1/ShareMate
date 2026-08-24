import { beforeEach, describe, expect, it } from 'vitest';
import { MemberMergeService } from './member-merge-service.js';
import {
  InMemoryCredentialRepository,
  InMemoryMemberRepository,
  RecordingAuditLogger,
  RecordingMemberMerger,
  NO_MERGE_COUNTS,
} from './testing/in-memory.js';
import { Member } from '../domain/member/member.js';
import { MemberCredential } from '../domain/auth/credential.js';
import { AuthorizationError, ConflictError, DomainError, NotFoundError } from '../domain/shared/domain-error.js';

/**
 * Ce que la couche application décide autour de la fusion : qui a le droit de la demander, sous
 * quelle identité le compte conservé continue, et ce qui en reste au journal. Le déplacement des
 * données, lui, s'éprouve sur la base réelle (`persistence/sqlite/member-merge.test.ts`).
 */

let members: InMemoryMemberRepository;
let credentials: InMemoryCredentialRepository;
let merger: RecordingMemberMerger;
let audit: RecordingAuditLogger;
let service: MemberMergeService;

beforeEach(async () => {
  members = new InMemoryMemberRepository();
  credentials = new InMemoryCredentialRepository();
  merger = new RecordingMemberMerger({ ...NO_MERGE_COUNTS, expenseSplits: 3, sessionsRevoked: 1 });
  audit = new RecordingAuditLogger();
  service = new MemberMergeService(members, credentials, merger, audit);

  await members.save(Member.create({ id: 'alice', name: 'Alice', isAdmin: true }));
  await members.save(Member.create({ id: 'ancien', name: 'Damien', email: 'damien@example.org' }));
  await members.save(Member.create({ id: 'nouveau', name: 'Damien' }));
  await credentials.save(MemberCredential.create({ memberId: 'nouveau', passwordHash: 'plain:x' }));
});

describe('Fusion de comptes — qui peut la demander', () => {
  it('refuse tout autre que l’administrateur, sans rien dire des comptes visés', async () => {
    for (const geste of [
      () => service.merge('ancien', 'ancien', 'nouveau'),
      () => service.preview('ancien', 'ancien', 'nouveau'),
      () => service.listMembers('ancien'),
      // Un identifiant qui ne désigne personne reçoit le même refus, au même endroit.
      () => service.merge('fantôme', 'ancien', 'nouveau'),
    ]) {
      await expect(geste()).rejects.toThrow(AuthorizationError);
    }
    // Le refus tombe avant toute lecture des comptes visés : rien n'a été tenté.
    expect(merger.merged).toEqual([]);
    expect(merger.previewed).toEqual([]);
  });

  it('refuse aussi le geste avec un identifiant de compte inexistant, sans le distinguer', async () => {
    // Le message est le même que celui d'un membre absent partout ailleurs dans l'API.
    await expect(service.merge('alice', 'inconnu', 'nouveau')).rejects.toThrow(NotFoundError);
    await expect(service.merge('alice', 'ancien', 'inconnu')).rejects.toThrow(NotFoundError);
  });

  it('montre à l’administrateur tous les comptes, périmètre relationnel compris', async () => {
    const annuaire = await service.listMembers('alice');
    // Les deux Damien sont là, sous le même nom : c'est précisément ce que l'annuaire cadré ne
    // montrait plus, et ce qui permet de les distinguer par leur état d'ouverture.
    // Deux comptes de même nom : leur ordre relatif n'est pas promis par le port, on range.
    const rangé = annuaire.map((e) => [e.member.id, e.hasPassword]).sort();
    expect(rangé).toEqual([
      ['alice', false],
      ['ancien', false],
      ['nouveau', true],
    ]);
  });
});

describe('Fusion de comptes — ce qui est refusé', () => {
  it('refuse un compte fusionné avec lui-même', async () => {
    await expect(service.merge('alice', 'ancien', 'ancien')).rejects.toThrow(DomainError);
    expect(merger.merged).toEqual([]);
  });

  it('refuse d’absorber l’administrateur — le geste ne se redonne pas depuis l’application', async () => {
    await expect(service.merge('alice', 'alice', 'nouveau')).rejects.toThrow(ConflictError);
    // L'inverse est permis : l'administrateur peut absorber un autre compte.
    await expect(service.merge('alice', 'ancien', 'alice')).resolves.toBeDefined();
  });

  it('refuse une identité dont l’email est déjà celui d’un autre membre', async () => {
    await members.save(Member.create({ id: 'chloe', name: 'Chloé', email: 'chloe@example.org' }));
    await expect(service.merge('alice', 'ancien', 'nouveau', { email: 'chloe@example.org' })).rejects.toThrow(
      ConflictError,
    );
    // Reprendre l'adresse de l'absorbé, elle, n'est pas une collision : elle disparaît avec lui.
    await expect(service.merge('alice', 'ancien', 'nouveau', { email: 'damien@example.org' })).resolves.toBeDefined();
  });

  it('refuse un nom vide ou un email mal formé', async () => {
    await expect(service.merge('alice', 'ancien', 'nouveau', { name: '   ' })).rejects.toThrow(DomainError);
    await expect(service.merge('alice', 'ancien', 'nouveau', { email: 'pas-une-adresse' })).rejects.toThrow(
      DomainError,
    );
  });
});

describe('Fusion de comptes — identité retenue', () => {
  it('garde celle du conservé quand rien n’est choisi', async () => {
    const { member } = await service.merge('alice', 'ancien', 'nouveau');
    expect(member.name).toBe('Damien');
    expect(member.email).toBeNull();
    expect(merger.merged).toEqual([{ absorbedId: 'ancien', keptId: 'nouveau', name: 'Damien', email: null }]);
  });

  it('retient les champs choisis un par un, et sait effacer l’email', async () => {
    await members.save(Member.create({ id: 'nouveau', name: 'Damien', email: 'dam@example.org' }));

    const repris = await service.merge('alice', 'ancien', 'nouveau', { name: 'Damien Roux' });
    expect(repris.member.name).toBe('Damien Roux');
    expect(repris.member.email).toBe('dam@example.org'); // champ non choisi : inchangé

    const effacé = await service.merge('alice', 'ancien', 'nouveau', { email: null });
    expect(effacé.member.email).toBeNull();
  });

  it('garde l’identifiant et le rôle du compte conservé', async () => {
    const { member } = await service.merge('alice', 'ancien', 'alice', { name: 'Alice' });
    expect(member.id).toBe('alice');
    expect(member.isAdmin).toBe(true);
  });
});

describe('Fusion de comptes — traçabilité', () => {
  it('journalise l’acteur, les deux comptes et ce qui a été déplacé', async () => {
    const { counts } = await service.merge('alice', 'ancien', 'nouveau', { name: 'Damien' });

    expect(counts.expenseSplits).toBe(3);
    expect(audit.entries).toEqual([
      {
        action: 'membre.fusionne',
        actorId: 'alice',
        targetId: 'nouveau',
        details: { absorbedId: 'ancien', absorbedName: 'Damien', keptName: 'Damien', ...counts },
      },
    ]);
  });

  it('ne journalise rien quand la fusion est refusée', async () => {
    await expect(service.merge('alice', 'ancien', 'ancien')).rejects.toThrow(DomainError);
    expect(audit.entries).toEqual([]);
  });

  it('annonce l’aperçu sans rien fusionner', async () => {
    const annoncé = await service.preview('alice', 'ancien', 'nouveau');
    expect(annoncé.expenseSplits).toBe(3);
    expect(merger.previewed).toEqual([{ absorbedId: 'ancien', keptId: 'nouveau' }]);
    expect(merger.merged).toEqual([]);
    expect(audit.entries).toEqual([]);
  });
});
