import { Group } from '../domain/group/group.js';
import { Member } from '../domain/group/member.js';
import { NotFoundError } from '../domain/shared/domain-error.js';
import type { GroupRepository, IdGenerator, MemberRepository } from './ports.js';

export interface CreateGroupInput {
  name: string;
  members: { name: string; email?: string | null }[];
}

export class GroupService {
  constructor(
    private readonly groups: GroupRepository,
    private readonly members: MemberRepository,
    private readonly idGenerator: IdGenerator,
  ) {}

  async createGroup(input: CreateGroupInput): Promise<Group> {
    const members = input.members.map((m) =>
      Member.create({ id: this.idGenerator.next(), name: m.name, email: m.email ?? null }),
    );
    const group = Group.create({
      id: this.idGenerator.next(),
      name: input.name,
      memberIds: members.map((m) => m.id),
    });
    for (const member of members) {
      await this.members.save(member);
    }
    await this.groups.save(group);
    return group;
  }

  async addMember(groupId: string, input: { name: string; email?: string | null }): Promise<Member> {
    const group = await this.groups.findById(groupId);
    if (!group) {
      throw new NotFoundError(`Groupe introuvable : ${groupId}`);
    }
    const member = Member.create({ id: this.idGenerator.next(), name: input.name, email: input.email ?? null });
    await this.members.save(member);
    await this.groups.save(group.addMember(member.id));
    return member;
  }

  async getGroup(groupId: string): Promise<Group> {
    const group = await this.groups.findById(groupId);
    if (!group) {
      throw new NotFoundError(`Groupe introuvable : ${groupId}`);
    }
    return group;
  }

  async listGroups(): Promise<Group[]> {
    return this.groups.findAll();
  }

  async listMembers(groupId: string): Promise<Member[]> {
    const group = await this.getGroup(groupId);
    const all = await this.members.findAll();
    return all.filter((m) => group.hasMember(m.id));
  }
}
