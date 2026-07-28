import { DomainError } from '../shared/domain-error.js';

export interface MemberCredentialProps {
  memberId: string;
  passwordHash?: string | null;
  inviteCode?: string | null;
  inviteExpiresAt?: Date | null;
}

/** Accès d'un membre : mot de passe défini, et/ou code d'invitation en attente. */
export class MemberCredential {
  private constructor(
    readonly memberId: string,
    readonly passwordHash: string | null,
    readonly inviteCode: string | null,
    readonly inviteExpiresAt: Date | null,
  ) {}

  static create(props: MemberCredentialProps): MemberCredential {
    const passwordHash = props.passwordHash ?? null;
    const inviteCode = props.inviteCode ?? null;
    if (passwordHash === null && inviteCode === null) {
      throw new DomainError("Un accès sans mot de passe doit porter un code d'invitation.");
    }
    return new MemberCredential(props.memberId, passwordHash, inviteCode, props.inviteExpiresAt ?? null);
  }

  get hasPassword(): boolean {
    return this.passwordHash !== null;
  }

  /**
   * Un code n'est exploitable qu'avec une échéance encore à venir. Une invitation sans échéance
   * est tenue pour périmée : c'est une rangée antérieure à l'introduction de l'expiration, donc
   * un code diffusé hors bande depuis une durée inconnue.
   */
  isInviteValid(now: Date): boolean {
    return this.inviteCode !== null && this.inviteExpiresAt !== null && this.inviteExpiresAt.getTime() > now.getTime();
  }

  /** Pose le mot de passe et invalide toute invitation en attente. */
  withPassword(passwordHash: string): MemberCredential {
    return new MemberCredential(this.memberId, passwordHash, null, null);
  }

  /** Nouvelle invitation, valable jusqu'à `expiresAt` ; l'ancien mot de passe reste valable. */
  withInvite(inviteCode: string, expiresAt: Date): MemberCredential {
    return new MemberCredential(this.memberId, this.passwordHash, inviteCode, expiresAt);
  }
}
