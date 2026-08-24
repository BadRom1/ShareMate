import type { Member } from '../domain/member/member.js';
import { AuthorizationError, ConflictError, DomainError, NotFoundError } from '../domain/shared/domain-error.js';
import type { DirectoryEntry } from './member-service.js';
import type { AuditLogger, CredentialRepository, MemberMerger, MemberRepository, MergeCounts } from './ports.js';

/** Identité retenue pour le compte conservé ; un champ absent garde la valeur qu'il portait déjà. */
export interface MergeIdentity {
  name?: string;
  email?: string | null;
}

export interface MergeResult {
  /** Le compte conservé, tel qu'il continue après la fusion. */
  member: Member;
  counts: MergeCounts;
}

/**
 * Message d'absence d'un membre, réutilisé tel quel pour masquer un refus (cf. auth-service).
 */
function memberNotFound(memberId: string): string {
  return `Membre introuvable : ${memberId}`;
}

/**
 * Fusion de deux comptes du même membre, réservée à l'administrateur de l'instance.
 *
 * Le doublon naît d'une perte de lien : deux personnes que seul un équipement réunissait sortent
 * du champ de vision l'une de l'autre quand il disparaît, et l'une recrée l'autre. Il reste alors
 * deux comptes — l'un porte l'historique, l'autre l'accès qui fonctionne —, et rien ne permettait
 * de les réunir : aucune route n'efface un membre. C'est ce que ce service répare.
 *
 * Qui absorbe qui ne se déduit pas : l'administrateur le dit, et dit aussi sous quel nom et quel
 * email le compte conservé continue. Ce que la fusion déplace se lit avant de la faire
 * (`preview`), et ce qu'elle a déplacé part au journal des gestes sensibles.
 */
export class MemberMergeService {
  constructor(
    private readonly members: MemberRepository,
    private readonly credentials: CredentialRepository,
    private readonly merger: MemberMerger,
    private readonly audit: AuditLogger,
  ) {}

  /**
   * Tous les membres de l'instance, périmètre relationnel ignoré : c'est la seule vue qui le
   * fasse, et c'est ce qu'il faut pour retrouver deux comptes que plus aucun cercle ne relie.
   * L'annuaire ordinaire (`/api/members`) reste cadré — cette route ne l'élargit pas, elle
   * s'ouvre ailleurs, à un seul compte.
   */
  async listMembers(actorId: string): Promise<DirectoryEntry[]> {
    await this.assertAdmin(actorId);
    const members = await this.members.findAll();
    const withPassword = await this.credentials.findMemberIdsWithPassword(members.map((m) => m.id));
    return members.map((member) => ({ member, hasPassword: withPassword.has(member.id) }));
  }

  /** Ce que la fusion déplacerait, à annoncer avant de la confirmer. */
  async preview(actorId: string, absorbedId: string, keptId: string): Promise<MergeCounts> {
    await this.assertAdmin(actorId);
    await this.assertMergeable(absorbedId, keptId);
    return this.merger.preview(absorbedId, keptId);
  }

  async merge(actorId: string, absorbedId: string, keptId: string, identity: MergeIdentity = {}): Promise<MergeResult> {
    await this.assertAdmin(actorId);
    const { absorbed, kept } = await this.assertMergeable(absorbedId, keptId);
    const merged = kept.withIdentity(
      identity.name ?? kept.name,
      identity.email !== undefined ? identity.email : kept.email,
    );
    await this.assertEmailAvailable(merged, absorbedId);

    const counts = await this.merger.merge({
      absorbedId,
      keptId,
      name: merged.name,
      email: merged.email,
    });
    this.audit.record({
      action: 'membre.fusionne',
      actorId,
      targetId: keptId,
      details: { absorbedId, absorbedName: absorbed.name, keptName: merged.name, ...counts },
    });
    return { member: merged, counts };
  }

  /**
   * Refus opposé à tout autre que l'administrateur. Il ne dit rien des comptes visés — il est
   * rendu avant même de les chercher —, et se lit pour ce qu'il est : un geste réservé, pas une
   * ressource absente. C'est la posture d'`AuthorizationError` (403), là où un membre voit bien
   * qu'il existe quelque chose et n'a pas le droit d'y toucher.
   */
  private async assertAdmin(actorId: string): Promise<Member> {
    const actor = await this.members.findById(actorId);
    if (!actor?.isAdmin) {
      throw new AuthorizationError('Geste réservé à l’administrateur de l’instance.');
    }
    return actor;
  }

  /** Les deux comptes existent, sont distincts, et l'administrateur n'est pas celui qui disparaît. */
  private async assertMergeable(absorbedId: string, keptId: string): Promise<{ absorbed: Member; kept: Member }> {
    if (absorbedId === keptId) {
      throw new DomainError('Un compte ne se fusionne pas avec lui-même : choisissez deux comptes distincts.');
    }
    const absorbed = await this.members.findById(absorbedId);
    if (!absorbed) {
      throw new NotFoundError(memberNotFound(absorbedId));
    }
    const kept = await this.members.findById(keptId);
    if (!kept) {
      throw new NotFoundError(memberNotFound(keptId));
    }
    // L'administrateur peut absorber, jamais être absorbé : l'instance perdrait le seul compte
    // qui autorise ce geste, et le rôle ne se redonne que par un script, base à l'arrêt.
    if (absorbed.isAdmin) {
      throw new ConflictError('Le compte administrateur ne peut pas être absorbé : désignez-le comme compte conservé.');
    }
    return { absorbed, kept };
  }

  /**
   * L'email est un identifiant de connexion : la fusion ne doit pas en produire deux identiques.
   * La garde porte ici sur l'instance entière et non sur un périmètre (voir `AuthService`) : le
   * demandeur est l'administrateur, à qui la route montre déjà tous les comptes — il n'y a rien à
   * lui cacher, et une collision hors de son cercle resterait une collision.
   */
  private async assertEmailAvailable(kept: Member, absorbedId: string): Promise<void> {
    if (kept.email === null) {
      return;
    }
    const wanted = kept.email.toLowerCase();
    // Le port répond aussi sur le nom : seul un email réellement identique compte comme collision.
    // Les deux comptes de la fusion sont hors jeu — l'un continue sous cette adresse, l'autre
    // disparaît avec la sienne.
    const collision = (await this.members.findByNameOrEmail(kept.email)).some(
      (other) => other.email?.toLowerCase() === wanted && other.id !== kept.id && other.id !== absorbedId,
    );
    if (collision) {
      throw new ConflictError('Cette adresse email est déjà utilisée par un autre membre.');
    }
  }
}
