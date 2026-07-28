import type { Member } from '../domain/member/member.js';
import { visibleMemberIds } from './member-scope.js';
import type { CredentialRepository, EquipmentRepository, MemberRepository } from './ports.js';

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
  ) {}

  /**
   * Annuaire cadré sur le périmètre du demandeur (voir `visibleMemberIds`). Tout nom affiché par
   * le front (calendrier, dépenses, discussions, checklists) provient d'un cercle commun, donc
   * reste couvert ; en dehors, un membre n'a pas à connaître l'existence — ni l'email — des autres.
   *
   * C'est la route la plus chaude de l'application (chaque ouverture de page) : le périmètre est
   * calculé par les ports, puis chargé en deux interrogations. Relire l'annuaire complet pour le
   * filtrer en mémoire, avec une requête d'accès par membre, faisait payer à chaque page la taille
   * de l'instance.
   */
  async listVisibleMembers(requesterId: string): Promise<DirectoryEntry[]> {
    const visible = await visibleMemberIds(this.equipments, this.members, requesterId);
    const members = await this.members.findByIds([...visible]);
    const withPassword = await this.credentials.findMemberIdsWithPassword(members.map((m) => m.id));
    return members.map((member) => ({ member, hasPassword: withPassword.has(member.id) }));
  }
}
