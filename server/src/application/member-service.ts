import { Member } from '../domain/member/member.js';
import { NotFoundError } from '../domain/shared/domain-error.js';
import type { IdGenerator, MemberRepository } from './ports.js';

export interface CreateMemberInput {
  name: string;
  email?: string | null;
}

export class MemberService {
  constructor(
    private readonly members: MemberRepository,
    private readonly idGenerator: IdGenerator,
  ) {}

  async createMember(input: CreateMemberInput): Promise<Member> {
    const member = Member.create({ id: this.idGenerator.next(), name: input.name, email: input.email ?? null });
    await this.members.save(member);
    return member;
  }

  async getMember(id: string): Promise<Member> {
    const member = await this.members.findById(id);
    if (!member) {
      throw new NotFoundError(`Membre introuvable : ${id}`);
    }
    return member;
  }

  async listMembers(): Promise<Member[]> {
    return this.members.findAll();
  }
}
