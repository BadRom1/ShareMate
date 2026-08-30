import { DomainError } from '../shared/domain-error.js';

export interface MemberCredentialProps {
  memberId: string;
  passwordHash?: string | null;
  inviteCode?: string | null;
  inviteExpiresAt?: Date | null;
  resetCode?: string | null;
  resetExpiresAt?: Date | null;
}

/**
 * Accès d'un membre : mot de passe défini, et/ou code d'invitation en attente, et/ou code de
 * réinitialisation en cours.
 *
 * Invitation et réinitialisation portent des codes distincts parce qu'elles ne disent pas la même
 * chose : une invitation ouvre un compte qui n'a jamais eu de mot de passe, une réinitialisation
 * en remplace un qui existe. Confondues sur une seule colonne, un code émis dans un cas
 * s'exploiterait dans l'autre — c'est exactement la prise de contrôle de compte que la garde
 * d'invitation ferme (voir `AuthService.regenerateInvite`).
 */
export class MemberCredential {
  private constructor(
    readonly memberId: string,
    readonly passwordHash: string | null,
    readonly inviteCode: string | null,
    readonly inviteExpiresAt: Date | null,
    readonly resetCode: string | null,
    readonly resetExpiresAt: Date | null,
  ) {}

  static create(props: MemberCredentialProps): MemberCredential {
    const passwordHash = props.passwordHash ?? null;
    const inviteCode = props.inviteCode ?? null;
    if (passwordHash === null && inviteCode === null) {
      throw new DomainError("Un accès sans mot de passe doit porter un code d'invitation.");
    }
    return new MemberCredential(
      props.memberId,
      passwordHash,
      inviteCode,
      props.inviteExpiresAt ?? null,
      props.resetCode ?? null,
      props.resetExpiresAt ?? null,
    );
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

  /**
   * Même règle pour la réinitialisation, avec une exigence de plus : elle ne vaut que sur un
   * compte qui a un mot de passe. Un compte jamais ouvert relève de l'invitation, dont la
   * consommation ne remplace rien.
   */
  isResetValid(now: Date): boolean {
    return (
      this.hasPassword &&
      this.resetCode !== null &&
      this.resetExpiresAt !== null &&
      this.resetExpiresAt.getTime() > now.getTime()
    );
  }

  /** Pose le mot de passe et invalide tout code en attente — invitation comme réinitialisation. */
  withPassword(passwordHash: string): MemberCredential {
    return new MemberCredential(this.memberId, passwordHash, null, null, null, null);
  }

  /** Nouvelle invitation, valable jusqu'à `expiresAt` ; l'ancien mot de passe reste valable. */
  withInvite(inviteCode: string, expiresAt: Date): MemberCredential {
    return new MemberCredential(
      this.memberId,
      this.passwordHash,
      inviteCode,
      expiresAt,
      this.resetCode,
      this.resetExpiresAt,
    );
  }

  /**
   * Nouvelle réinitialisation, valable jusqu'à `expiresAt`. Le mot de passe en place continue de
   * fonctionner jusqu'à ce que le code soit consommé : émettre un lien n'enferme personne dehors,
   * et le membre qui retrouve son mot de passe entre-temps n'a rien à faire. Un code antérieur,
   * lui, est remplacé — il n'y en a jamais deux valables à la fois.
   */
  withReset(resetCode: string, expiresAt: Date): MemberCredential {
    return new MemberCredential(
      this.memberId,
      this.passwordHash,
      this.inviteCode,
      this.inviteExpiresAt,
      resetCode,
      expiresAt,
    );
  }
}
