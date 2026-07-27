import { beforeEach, describe, expect, it } from 'vitest';
import { makeFixture } from './testing/fixture.js';
import { MemberService } from './member-service.js';
import { InMemoryCredentialRepository, InMemoryMemberRepository } from './testing/in-memory.js';
import { Member } from '../domain/member/member.js';
import { MemberCredential } from '../domain/auth/credential.js';

/** Doubles instrumentés : le coût de l'annuaire fait partie de son contrat (route la plus chaude). */
class CountingMembers extends InMemoryMemberRepository {
  byId = 0;
  override async findById(id: string) {
    this.byId += 1;
    return super.findById(id);
  }
}

class CountingCredentials extends InMemoryCredentialRepository {
  byMember = 0;
  override async findByMemberId(memberId: string) {
    this.byMember += 1;
    return super.findByMemberId(memberId);
  }
}

let fixture: Awaited<ReturnType<typeof makeFixture>>;

beforeEach(async () => {
  fixture = await makeFixture();
});

describe('MemberService — annuaire', () => {
  it('rend le périmètre du demandeur et l’état d’ouverture de chaque compte', async () => {
    await fixture.credentials.save(MemberCredential.create({ memberId: 'm1', passwordHash: 'plain:x' }));
    await fixture.credentials.save(MemberCredential.create({ memberId: 'm2', inviteCode: 'c' }));
    const service = new MemberService(fixture.members, fixture.equipments, fixture.credentials);

    // m1 partage la minipelle avec m2 et a invité m3.
    expect((await service.listVisibleMembers('m1')).map((e) => [e.member.name, e.hasPassword])).toEqual([
      ['Alice', true],
      ['Bruno', false],
      ['Chloé', false],
    ]);
    // m3 n'a aucun cercle : il ne lui reste que lui-même et son invitant.
    expect((await service.listVisibleMembers('m3')).map((e) => e.member.name)).toEqual(['Alice', 'Chloé']);
  });

  it('ne relit pas l’annuaire de l’instance et n’interroge pas les accès membre par membre', async () => {
    const members = new CountingMembers();
    const credentials = new CountingCredentials();
    for (const [id, name] of [
      ['m1', 'Alice'],
      ['m2', 'Bruno'],
    ]) {
      await members.save(Member.create({ id: id!, name: name! }));
    }
    // Cent membres étrangers : leur nombre ne doit peser ni sur le résultat ni sur le travail.
    for (let i = 0; i < 100; i += 1) {
      await members.save(Member.create({ id: `x${i}`, name: `Étranger ${i}` }));
    }
    const service = new MemberService(members, fixture.equipments, credentials);

    const vus = await service.listVisibleMembers('m1');

    expect(vus.map((e) => e.member.id)).toEqual(['m1', 'm2']); // le cercle de la minipelle, rien d'autre
    // Une seule lecture par identifiant : celle du demandeur, pour remonter à son invitant.
    expect(members.byId).toBe(1);
    expect(credentials.byMember).toBe(0);
  });
});
