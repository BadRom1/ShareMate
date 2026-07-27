import { Member } from '../domain/member/member.js';
import { NotFoundError } from '../domain/shared/domain-error.js';
import { circleMemberIds } from './equipment-access.js';
import type { CredentialRepository, EquipmentRepository, IdGenerator, MemberRepository } from './ports.js';

export interface CreateMemberInput {
  name: string;
  email?: string | null;
}

/** Membre de l'annuaire, vu par un demandeur donné. */
export interface DirectoryEntry {
  member: Member;
  /** Un compte sans mot de passe n'a jamais été ouvert : lui seul peut recevoir un lien de première connexion. */
  hasPassword: boolean;
}

export class MemberService {
  constructor(
    private readonly members: MemberRepository,
    private readonly equipments: EquipmentRepository,
    private readonly credentials: CredentialRepository,
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

  /**
   * Annuaire cadré sur le périmètre du demandeur : lui-même, les membres des cercles qu'il partage,
   * et ceux qu'il a invités mais avec qui aucun équipement n'est encore partagé. Tout nom affiché
   * par le front (calendrier, dépenses, discussions, checklists) provient d'un cercle commun, donc
   * reste couvert ; en dehors, un membre n'a pas à connaître l'existence — ni l'email — des autres.
   */
  async listVisibleMembers(requesterId: string): Promise<DirectoryEntry[]> {
    const visible = await circleMemberIds(this.equipments, requesterId);
    const entries: DirectoryEntry[] = [];
    for (const member of await this.members.findAll()) {
      if (!visible.has(member.id) && member.invitedById !== requesterId) continue;
      const credential = await this.credentials.findByMemberId(member.id);
      entries.push({ member, hasPassword: credential?.hasPassword ?? false });
    }
    return entries;
  }
}
