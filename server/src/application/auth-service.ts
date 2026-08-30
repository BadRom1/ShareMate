import { Member } from '../domain/member/member.js';
import { MemberCredential } from '../domain/auth/credential.js';
import {
  AuthorizationError,
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../domain/shared/domain-error.js';
import { visibleMemberIds } from './member-scope.js';
import type {
  AuditLogger,
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
// 24 h : ce code-là remplace le mot de passe d'un compte en service, il n'a pas à traîner une
// semaine dans une conversation. Assez long pour couvrir un décalage horaire ou une soirée.
const RESET_TTL_MS = 24 * 60 * 60 * 1000;
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
    private readonly audit: AuditLogger,
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
    // Sans demandeur ni instance à sonder (le bootstrap n'ouvre que sur une base vierge), la
    // collision se cherche partout.
    await this.assertEmailAvailable(member, null);
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
    // Le rôle d'administrateur n'est posé qu'une fois le premier accès emporté, et jamais avant :
    // écrit à la création du membre, il resterait sur le perdant d'un bootstrap concurrent — un
    // compte sans accès, que personne ne peut ouvrir, mais qui porterait le droit d'en absorber
    // d'autres si un accès lui était rendu plus tard.
    const admin = Member.create({
      id: member.id,
      name: member.name,
      email: member.email,
      invitedById: member.invitedById,
      isAdmin: true,
    });
    await this.members.save(admin);
    return { member: admin, session: await this.openSession(admin.id) };
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
    await this.assertEmailAvailable(member, await visibleMemberIds(this.equipments, this.members, requesterId));
    await this.members.save(member);
    const inviteCode = this.tokens.inviteCode();
    await this.credentials.save(
      MemberCredential.create({ memberId: member.id, inviteCode, inviteExpiresAt: this.inviteDeadline() }),
    );
    return { member, inviteCode };
  }

  /**
   * Nouveau code de première connexion, réservé au titulaire et à celui qui l'a invité.
   *
   * Le cercle commun ne suffit pas : sur un compte jamais ouvert, un code régénéré ne relance pas
   * une invitation, il prend le compte — celui qui le consomme choisit le mot de passe, hérite des
   * cercles du titulaire et l'enferme dehors (`hasPassword` bloque ensuite toute relance). Comme
   * la composition d'un cercle se décide sans l'intéressé, tout membre pouvait s'inscrire dans un
   * équipement avec sa cible pour entrer dans son périmètre. L'invitant, lui, est le seul à qui
   * l'on doit déjà d'exister dans l'instance.
   *
   * Hors de ce couple, le refus est masqué derrière l'absence du membre : impossible de découvrir
   * qu'un identifiant correspond à un compte.
   */
  async regenerateInvite(memberId: string, requesterId: string): Promise<string> {
    const member = await this.members.findById(memberId);
    if (!member) {
      throw new NotFoundError(memberNotFound(memberId));
    }
    if (member.id !== requesterId && member.invitedById !== requesterId) {
      throw new ForbiddenError(memberNotFound(memberId));
    }
    const existing = await this.credentials.findByMemberId(memberId);
    // Une invitation n'est pas une réinitialisation : sans cette garde, obtenir un code pour un
    // compte ouvert revient à en prendre le contrôle. Un mot de passe perdu se règle par
    // `startPasswordReset`, réservé à l'administrateur, sur un code qui lui est propre.
    if (existing?.hasPassword) {
      throw new ConflictError(
        "Ce membre a déjà un mot de passe : un lien d'invitation ne le réinitialise pas. " +
          'Un mot de passe perdu se redonne depuis l’écran d’administration.',
      );
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

  /**
   * Lien de réinitialisation pour un mot de passe perdu, réservé à l'administrateur de l'instance.
   *
   * C'est le pendant du lien de première connexion, pour le cas qu'il refuse : un compte déjà
   * ouvert dont le titulaire a perdu son mot de passe. Sans lui, il ne restait qu'à recréer la
   * personne puis à fusionner les deux comptes — un geste plus lourd, irréversible, et qui passe
   * de toute façon par l'administrateur.
   *
   * Réservé à lui, donc, et à personne d'autre : ce code reprend un compte en service. L'ouvrir
   * à l'invitant, comme l'est la relance d'invitation, lui donnerait sur son invité un pouvoir de
   * reprise permanent, que celui-ci n'a jamais accordé et ne peut pas retirer. L'administrateur,
   * lui, ne gagne rien qu'il n'ait déjà : la fusion absorbe une identité entière, et il peut donc
   * s'en emparer par un chemin plus destructeur. Le refus opposé aux autres se lit pour ce qu'il
   * est — un geste réservé, non une ressource absente — comme celui de la fusion.
   *
   * Émettre un lien ne révoque rien : le mot de passe en place et les sessions ouvertes tiennent
   * jusqu'à ce que le code soit consommé. Un lien émis à tort, ou par erreur, n'enferme donc
   * personne dehors ; il suffit de ne pas s'en servir, et il expire.
   */
  async startPasswordReset(memberId: string, requesterId: string): Promise<{ member: Member; resetCode: string }> {
    const requester = await this.members.findById(requesterId);
    if (!requester?.isAdmin) {
      throw new AuthorizationError('Geste réservé à l’administrateur de l’instance.');
    }
    const member = await this.memberOf(memberId);
    const existing = await this.credentials.findByMemberId(memberId);
    // Un compte jamais ouvert n'a pas de mot de passe à remplacer : c'est un lien de première
    // connexion qu'il lui faut, et le message le dit plutôt que d'émettre un code sans emploi.
    if (!existing?.hasPassword) {
      throw new ConflictError(
        "Ce membre n'a jamais choisi de mot de passe : envoyez-lui un lien de première connexion.",
      );
    }
    const resetCode = this.tokens.resetCode();
    await this.credentials.save(existing.withReset(resetCode, this.resetDeadline()));
    // Le geste ouvre la reprise d'un compte qui n'est pas celui du demandeur : il laisse une
    // trace côté exploitant, comme la fusion.
    this.audit.record({
      action: 'membre.reinitialisation-emise',
      actorId: requesterId,
      targetId: memberId,
      details: { targetName: member.name },
    });
    return { member, resetCode };
  }

  /** Membre associé à un code de réinitialisation encore valable. */
  async resetInfo(code: string): Promise<Member> {
    const credential = await this.pendingReset(code);
    return this.memberOf(credential.memberId);
  }

  /**
   * Consomme une réinitialisation : le membre choisit un nouveau mot de passe et est connecté.
   *
   * Toutes les sessions du compte tombent — c'est le geste réflexe après une compromission, et le
   * titulaire qui reprend son compte doit pouvoir en expulser qui s'y trouverait. La session
   * rendue ici est la seule qui survit.
   */
  async redeemPasswordReset(code: string, password: string): Promise<AuthResult> {
    const credential = await this.pendingReset(code);
    validatePassword(password);
    await this.credentials.save(credential.withPassword(await this.hasher.hash(password)));
    await this.sessions.deleteByMemberId(credential.memberId);
    const member = await this.memberOf(credential.memberId);
    return { member, session: await this.openSession(member.id) };
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
    let derivationDone = false;
    for (const member of candidates) {
      const credential = await this.credentials.findByMemberId(member.id);
      if (!credential?.passwordHash) {
        continue;
      }
      derivationDone = true;
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
    if (!derivationDone) {
      await this.hasher.hash(password);
    }
    throw new UnauthorizedError('Identifiants invalides.');
  }

  /** Session portée par ce jeton, avec prolongation glissante ; null si elle n'est plus valable. */
  async authenticate(token: string | undefined): Promise<AuthenticatedSession | null> {
    // Le jeton absent n'est pas court-circuité : il est haché et cherché comme un autre. Aucun
    // branchement ne dépend donc de ce que porte l'appelant, et « pas de jeton » suit exactement
    // le chemin — et le temps — de « jeton inconnu ». L'empreinte de la chaîne vide ne peut
    // appareiller aucune session : elles portent toutes l'empreinte de 32 octets aléatoires.
    const tokenHash = this.tokens.hash(token ?? '');
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
   *
   * `scope` borne la collision aux membres que le demandeur voit déjà. Une garde à l'échelle de
   * l'instance ne peut pas dire « cette adresse est prise » sans le dire aussi à qui la sonde :
   * n'importe quel membre authentifié obtenait ainsi, adresse par adresse, la liste des comptes
   * de l'instance entière — le canal même que le cadrage de l'annuaire ferme. Hors périmètre, le
   * doublon est donc accepté ; l'ambiguïté résiduelle reste théorique, `login` n'ouvrant que le
   * compte dont le mot de passe correspond, que l'attaquant ne connaît pas.
   */
  private async assertEmailAvailable(member: Member, scope: Set<string> | null): Promise<void> {
    if (member.email === null) {
      return;
    }
    // Le port répond aussi sur le nom : seul un email réellement identique compte comme collision.
    const wanted = member.email.toLowerCase();
    const collision = (await this.members.findByNameOrEmail(member.email)).some(
      (other) => other.email?.toLowerCase() === wanted && (scope === null || scope.has(other.id)),
    );
    if (collision) {
      throw new ConflictError('Cette adresse email est déjà utilisée par un autre membre.');
    }
  }

  private inviteDeadline(): Date {
    return new Date(this.clock.now().getTime() + INVITE_TTL_MS);
  }

  private resetDeadline(): Date {
    return new Date(this.clock.now().getTime() + RESET_TTL_MS);
  }

  /**
   * Réinitialisation exploitable : code connu, non expiré, sur un compte qui a bien un mot de
   * passe. Le même message couvre l'inconnu, l'expiré et le consommé — un code déjà utilisé a
   * disparu avec le mot de passe qu'il a posé —, si bien que rien ne permet de les sonder.
   */
  private async pendingReset(code: string): Promise<MemberCredential> {
    const credential = await this.credentials.findByResetCode(code);
    if (!credential || !credential.isResetValid(this.clock.now())) {
      throw new NotFoundError('Lien de réinitialisation invalide, expiré ou déjà utilisé.');
    }
    return credential;
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
