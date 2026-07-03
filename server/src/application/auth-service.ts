import { Member } from '../domain/member/member.js';
import { MemberCredential } from '../domain/auth/credential.js';
import { ConflictError, DomainError, NotFoundError, UnauthorizedError } from '../domain/shared/domain-error.js';
import type {
  Clock,
  CredentialRepository,
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

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours, expiration glissante
const MIN_PASSWORD_LENGTH = 8;

function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new DomainError(`Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`);
  }
}

export class AuthService {
  constructor(
    private readonly members: MemberRepository,
    private readonly credentials: CredentialRepository,
    private readonly sessions: SessionRepository,
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
    await this.members.save(member);
    await this.credentials.save(
      MemberCredential.create({ memberId: member.id, passwordHash: await this.hasher.hash(input.password) }),
    );
    return { member, session: await this.openSession(member.id) };
  }

  /** Crée un membre et son invitation ; le code est à transmettre hors application. */
  async createMemberWithInvite(input: { name: string; email?: string | null }): Promise<{ member: Member; inviteCode: string }> {
    const member = Member.create({ id: this.idGenerator.next(), name: input.name, email: input.email ?? null });
    await this.members.save(member);
    const inviteCode = this.tokens.inviteCode();
    await this.credentials.save(MemberCredential.create({ memberId: member.id, inviteCode }));
    return { member, inviteCode };
  }

  /** Nouveau code d'invitation (mot de passe perdu, code égaré, membre pré-existant). */
  async regenerateInvite(memberId: string): Promise<string> {
    const member = await this.members.findById(memberId);
    if (!member) {
      throw new NotFoundError(`Membre introuvable : ${memberId}`);
    }
    const existing = await this.credentials.findByMemberId(memberId);
    const inviteCode = this.tokens.inviteCode();
    await this.credentials.save(existing ? existing.withInvite(inviteCode) : MemberCredential.create({ memberId, inviteCode }));
    return inviteCode;
  }

  /** Membre associé à un code d'invitation encore valable. */
  async inviteInfo(code: string): Promise<Member> {
    const credential = await this.credentials.findByInviteCode(code);
    if (!credential) {
      throw new NotFoundError('Invitation invalide ou déjà utilisée.');
    }
    return this.memberOf(credential.memberId);
  }

  /** Consomme une invitation : le membre définit son mot de passe et est connecté. */
  async redeemInvite(code: string, password: string): Promise<AuthResult> {
    const credential = await this.credentials.findByInviteCode(code);
    if (!credential) {
      throw new NotFoundError('Invitation invalide ou déjà utilisée.');
    }
    validatePassword(password);
    await this.credentials.save(credential.withPassword(await this.hasher.hash(password)));
    const member = await this.memberOf(credential.memberId);
    return { member, session: await this.openSession(member.id) };
  }

  /** Connexion par nom ou email (insensible à la casse). */
  async login(identifier: string, password: string): Promise<AuthResult> {
    const needle = identifier.trim().toLowerCase();
    const candidates = (await this.members.findAll()).filter(
      (m) => m.name.toLowerCase() === needle || m.email?.toLowerCase() === needle,
    );
    for (const member of candidates) {
      const credential = await this.credentials.findByMemberId(member.id);
      if (credential?.passwordHash && (await this.hasher.verify(password, credential.passwordHash))) {
        return { member, session: await this.openSession(member.id) };
      }
    }
    throw new UnauthorizedError('Identifiants invalides.');
  }

  /** Membre de la session portée par ce jeton, avec prolongation glissante ; null sinon. */
  async authenticate(token: string): Promise<Member | null> {
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
    await this.sessions.save({ ...session, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) });
    return member;
  }

  async logout(token: string): Promise<void> {
    await this.sessions.delete(this.tokens.hash(token));
  }

  async changePassword(memberId: string, currentPassword: string, newPassword: string): Promise<void> {
    const credential = await this.credentials.findByMemberId(memberId);
    if (!credential?.passwordHash || !(await this.hasher.verify(currentPassword, credential.passwordHash))) {
      throw new UnauthorizedError('Mot de passe actuel incorrect.');
    }
    validatePassword(newPassword);
    await this.credentials.save(credential.withPassword(await this.hasher.hash(newPassword)));
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
      throw new NotFoundError(`Membre introuvable : ${memberId}`);
    }
    return member;
  }
}
