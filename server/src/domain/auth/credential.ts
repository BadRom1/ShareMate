import { DomainError } from '../shared/domain-error.js';

export interface MemberCredentialProps {
  memberId: string;
  passwordHash?: string | null;
  inviteCode?: string | null;
}

/** Accès d'un membre : mot de passe défini, et/ou code d'invitation en attente. */
export class MemberCredential {
  private constructor(
    readonly memberId: string,
    readonly passwordHash: string | null,
    readonly inviteCode: string | null,
  ) {}

  static create(props: MemberCredentialProps): MemberCredential {
    const passwordHash = props.passwordHash ?? null;
    const inviteCode = props.inviteCode ?? null;
    if (passwordHash === null && inviteCode === null) {
      throw new DomainError("Un accès sans mot de passe doit porter un code d'invitation.");
    }
    return new MemberCredential(props.memberId, passwordHash, inviteCode);
  }

  get hasPassword(): boolean {
    return this.passwordHash !== null;
  }

  /** Pose le mot de passe et invalide toute invitation en attente. */
  withPassword(passwordHash: string): MemberCredential {
    return new MemberCredential(this.memberId, passwordHash, null);
  }

  /** Nouvelle invitation (premier accès ou mot de passe perdu) ; l'ancien mot de passe reste valable. */
  withInvite(inviteCode: string): MemberCredential {
    return new MemberCredential(this.memberId, this.passwordHash, inviteCode);
  }
}
