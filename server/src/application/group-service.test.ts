import { beforeEach, describe, expect, it } from 'vitest';
import { makeFixture } from './testing/fixture.js';
import { GroupService } from './group-service.js';

let f: Awaited<ReturnType<typeof makeFixture>>;
let service: GroupService;

beforeEach(async () => {
  f = await makeFixture();
  service = new GroupService(f.groups, f.members, f.idGenerator);
});

describe('GroupService', () => {
  it('crée un groupe avec ses membres en une opération', async () => {
    const g = await service.createGroup({
      name: 'Copains bricolage',
      members: [{ name: 'Denis' }, { name: 'Emma', email: 'emma@ex.fr' }],
    });
    expect(g.memberIds).toHaveLength(2);
    const members = await service.listMembers(g.id);
    expect(members.map((m) => m.name)).toEqual(['Denis', 'Emma']);
  });

  it('refuse un groupe sans membre', async () => {
    await expect(service.createGroup({ name: 'Vide', members: [] })).rejects.toThrow();
  });

  it('ajoute un membre à un groupe existant', async () => {
    const m = await service.addMember('g1', { name: 'Fanny' });
    const group = await f.groups.findById('g1');
    expect(group?.hasMember(m.id)).toBe(true);
  });

  it('liste les groupes', async () => {
    const list = await service.listGroups();
    expect(list.map((g) => g.id)).toContain('g1');
  });

  it('liste les membres d\'un groupe', async () => {
    const members = await service.listMembers('g1');
    expect(members.map((m) => m.id).sort()).toEqual(['m1', 'm2', 'm3']);
  });
});
