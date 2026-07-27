import { Member } from '../domain/member/member.js';
import { MemberCredential } from '../domain/auth/credential.js';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../domain/shared/domain-error.js';
import { circleMemberIds } from './equipment-access.js';
import type {
  Clock,
  CredentialRepository,
  EquipmentRepository,
  IdGenerator,
  MemberRepository,
  PasswordHasher,
  SessionRepository,
  TokenGenerator,
} from './ports.js';

export interface AuthSession {
  /** Jeton opaque à remettre au client (cookie). */
  token: string;
  expiresAt: Date;
}

export interface AuthResult {
  member: Member;
  session: AuthSession;
}

/** Session reconnue par `authenticate` : `renewed` signale une échéance repoussée à rendre au client. */
export interface AuthenticatedSession {
  member: Member;
  expiresAt: Date;
  renewed: boolean;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours, expiration glissante
const SESSION_RENEWAL_THRESHOLD_MS = SESSION_TTL_MS / 3; // en deçà, la session est repoussée
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours : un code circule hors bande (SMS, WhatsApp)
const MIN_PASSWORD_LENGTH = 8;

function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new DomainError(`Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`);
  }
}

/** Message d'absence d'un membre, réutilisé tel quel pour masquer un refus (cf. equipment-access). */
function memberNotFound(memberId: string): string {
  return `Membre introuvable : ${memberId}`;
}

export class AuthService {
  constructor(
    private readonly members: MemberRepository,
    private readonly credentials: CredentialRepository,
    private readonly sessions: SessionRepository,
    private readonly equipments: EquipmentRepository,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenGenerator,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /** Aucun accès en base : le tout premier compte reste à créer. */
  async needsBootstrap(): Promise<boolean> {
    return (await this.credentials.count()) === 0;
  }

  /** Crée le tout premier compte (membre + mot de passe) et ouvre sa session. */
  async bootstrap(input: { name: string; email?: string | null; password: string }): Promise<AuthResult> {
    if (!(await this.needsBootstrap())) {
      throw new ConflictError('Le premier compte existe déjà : connectez-vous.');
    }
    validatePassword(input.password);
    const member = Member.create({ id: this.idGenerator.next(), name: input.name, email: input.email ?? null });
    await this.assertEmailAvailable(member);
    await this.members.save(member);
    // `needsBootstrap` ci-dessus n'est qu'un raccourci : entre sa lecture et l'écriture, une autre
    // requête peut avoir créé le premier compte. Seul `saveFirst` tranche, atomiquement. Le membre
    // du perdant reste en base sans accès : il ne peut pas se connecter, et l'annuaire ne le montre
    // à personne (aucun cercle, aucun invitant).
    const claimed = await this.credentials.saveFirst(
      MemberCredential.create({ memberId: member.id, passwordHash: await this.hasher.hash(input.password) }),
    );
    if (!claimed) {
      throw new ConflictError('Le premier compte existe déjà : connectez-vous.');
    }
    return { member, session: await this.openSession(member.id) };
  }

  /** Crée un membre et son invitation ; le code est à transmettre hors application. */
  async createMemberWithInvite(
    input: { name: string; email?: string | null },
    requesterId: string,
  ): Promise<{ member: Member; inviteCode: string }> {
    const member = Member.create({
      id: this.idGenerator.next(),
      name: input.name,
      email: input.email ?? null,
      invitedById: requesterId,
    });
    await this.assertEmailAvailable(member);
    await this.members.save(member);
    const inviteCode = this.tokens.inviteCode();
    await this.credentials.save(
      MemberCredential.create({ memberId: member.id, inviteCode, inviteExpiresAt: this.inviteDeadline() }),
    );
    return { member, inviteCode };
  }

  /**
   * Nouveau code de première connexion pour un membre du périmètre du demandeur (lui-même, un
   * membre d'un de ses cercles, ou quelqu'un qu'il a invité). Hors périmètre, le refus est masqué
   * derrière l'absence du membre : impossible de découvrir qu'un identifiant correspond à un compte.
   */
  async regenerateInvite(memberId: string, requesterId: string): Promise<string> {
    const member = await this.members.findById(memberId);
    if (!member) {
      throw new NotFoundError(memberNotFound(memberId));
    }
    if (!(await this.isWithinScope(member, requesterId))) {
      throw new ForbiddenError(memberNotFound(memberId));
    }
    const existing = await this.credentials.findByMemberId(memberId);
    // Une invitation n'est pas une réinitialisation : sans cette garde, obtenir un code pour un
    // compte ouvert revient à en prendre le contrôle. Un mot de passe perdu se règle donc autrement.
    if (existing?.hasPassword) {
      throw new ConflictError("Ce membre a déjà un mot de passe : un lien d'invitation ne le réinitialise pas.");
    }
    const inviteCode = this.tokens.inviteCode();
    const expiresAt = this.inviteDeadline();
    await this.credentials.save(
      existing
        ? existing.withInvite(inviteCode, expiresAt)
        : MemberCredential.create({ memberId, inviteCode, inviteExpiresAt: expiresAt }),
    );
    return inviteCode;
  }

  /** Membre associé à un code d'invitation encore valable. */
  async inviteInfo(code: string): Promise<Member> {
    const credential = await this.pendingInvite(code);
    return this.memberOf(credential.memberId);
  }

  /** Consomme une invitation : le membre définit son mot de passe et est connecté. */
  async redeemInvite(code: string, password: string): Promise<AuthResult> {
    const credential = await this.pendingInvite(code);
    validatePassword(password);
    await this.credentials.save(credential.withPassword(await this.hasher.hash(password)));
    // Le compte vient d'être ouvert : toute session antérieure (appareil prêté, code recyclé)
    // n'a pas à survivre au choix du mot de passe.
    await this.sessions.deleteByMemberId(credential.memberId);
    const member = await this.memberOf(credential.memberId);
    return { member, session: await this.openSession(member.id) };
  }

  /** Connexion par nom ou email (insensible à la casse). */
  async login(identifier: string, password: string): Promise<AuthResult> {
    const candidates = await this.members.findByNameOrEmail(identifier);
    let dérivationFaite = false;
    for (const member of candidates) {
      const credential = await this.credentials.findByMemberId(member.id);
      if (!credential?.passwordHash) {
        continue;
      }
      dérivationFaite = true;
      if (await this.hasher.verify(password, credential.passwordHash)) {
        // Migration progressive du coût de hachage : durcir les paramètres n'invalide rien, chaque
        // membre est repassé au coût courant à sa première connexion suivante, sans le savoir.
        if (this.hasher.needsRehash(credential.passwordHash)) {
          await this.credentials.save(credential.withPassword(await this.hasher.hash(password)));
        }
        return { member, session: await this.openSession(member.id) };
      }
    }
    // Sans candidat vérifiable (identifiant inconnu, ou invitation jamais consommée), le refus
    // reviendrait sans aucune dérivation de clé : le temps de réponse trahirait alors l'existence
    // du compte, malgré le message générique. Un hachage leurre, de coût identique, referme ce canal.
    if (!dérivationFaite) {
      await this.hasher.hash(password);
    }
    throw new UnauthorizedError('Identifiants invalides.');
  }

  /** Session portée par ce jeton, avec prolongation glissante ; null si elle n'est plus valable. */
  async authenticate(token: string): Promise<AuthenticatedSession | null> {
    const tokenHash = this.tokens.hash(token);
    const session = await this.sessions.findByTokenHash(tokenHash);
    const now = this.clock.now();
    if (!session || session.expiresAt.getTime() <= now.getTime()) {
      return null;
    }
    const member = await this.members.findById(session.memberId);
    if (!member) {
      return null;
    }
    // Prolonger à chaque appel ferait de la moindre lecture d'API une transaction en écriture
    // SQLite — sur un volume réseau, c'est le point de contention de toute l'application. Repousser
    // l'échéance dans le dernier tiers du TTL suffit : un usage même épisodique la maintient ouverte.
    if (session.expiresAt.getTime() - now.getTime() < SESSION_RENEWAL_THRESHOLD_MS) {
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
      await this.sessions.save({ ...session, expiresAt });
      return { member, expiresAt, renewed: true };
    }
    return { member, expiresAt: session.expiresAt, renewed: false };
  }

  async logout(token: string): Promise<void> {
    await this.sessions.delete(this.tokens.hash(token));
  }

  /**
   * Change le mot de passe et révoque toutes les sessions du membre — le geste réflexe après une
   * compromission doit expulser l'intrus. La session du demandeur tombe avec les autres : la
   * nouvelle session renvoyée la remplace, sans quoi il se déconnecterait lui-même.
   */
  async changePassword(memberId: string, currentPassword: string, newPassword: string): Promise<AuthSession> {
    const credential = await this.credentials.findByMemberId(memberId);
    if (!credential?.passwordHash || !(await this.hasher.verify(currentPassword, credential.passwordHash))) {
      throw new UnauthorizedError('Mot de passe actuel incorrect.');
    }
    validatePassword(newPassword);
    await this.credentials.save(credential.withPassword(await this.hasher.hash(newPassword)));
    await this.sessions.deleteByMemberId(memberId);
    return this.openSession(memberId);
  }

  /**
   * L'email est un identifiant de connexion : partagé par deux membres, `login` retiendrait
   * arbitrairement le premier des deux dont le mot de passe correspond. La garde reste applicative
   * — le schéma ne porte pas d'index unique, la comparaison devant suivre `String.toLowerCase`
   * (voir `minuscule` dans database.ts) et non le repli ASCII de SQLite.
   */
  private async assertEmailAvailable(member: Member): Promise<void> {
    if (member.email === null) {
      return;
    }
    // Le port répond aussi sur le nom : seul un email réellement identique compte comme collision.
    const cherché = member.email.toLowerCase();
    if ((await this.members.findByNameOrEmail(member.email)).some((autre) => autre.email?.toLowerCase() === cherché)) {
      throw new ConflictError('Cette adresse email est déjà utilisée par un autre membre.');
    }
  }

  private inviteDeadline(): Date {
    return new Date(this.clock.now().getTime() + INVITE_TTL_MS);
  }

  /** Le demandeur peut-il agir sur ce membre : lui-même, son cercle, ou quelqu'un qu'il a invité. */
  private async isWithinScope(member: Member, requesterId: string): Promise<boolean> {
    if (member.id === requesterId || member.invitedById === requesterId) {
      return true;
    }
    return (await circleMemberIds(this.equipments, requesterId)).has(member.id);
  }

  /**
   * Invitation exploitable : code connu, non expiré, sur un compte encore sans mot de passe.
   * Le même message couvre l'inconnu, l'expiré et le consommé : rien ne permet de sonder les codes.
   */
  private async pendingInvite(code: string): Promise<MemberCredential> {
    const credential = await this.credentials.findByInviteCode(code);
    if (!credential || !credential.isInviteValid(this.clock.now())) {
      throw new NotFoundError('Invitation invalide, expirée ou déjà utilisée.');
    }
    // Filet de sécurité contre les codes émis au-dessus d'un mot de passe existant par les versions
    // antérieures : les consommer réécrirait le mot de passe du titulaire.
    if (credential.hasPassword) {
      throw new ConflictError('Ce compte a déjà un mot de passe : connectez-vous.');
    }
    return credential;
  }

  private async openSession(memberId: string): Promise<AuthSession> {
    const now = this.clock.now();
    await this.sessions.deleteExpired(now);
    const token = this.tokens.sessionToken();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.sessions.save({ tokenHash: this.tokens.hash(token), memberId, expiresAt });
    return { token, expiresAt };
  }

  private async memberOf(memberId: string): Promise<Member> {
    const member = await this.members.findById(memberId);
    if (!member) {
      throw new NotFoundError(memberNotFound(memberId));
    }
    return member;
  }
}
