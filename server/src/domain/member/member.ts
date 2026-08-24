import { DomainError } from '../shared/domain-error.js';

export interface MemberProps {
  id: string;
  name: string;
  email?: string | null;
  invitedById?: string | null;
  isAdmin?: boolean;
}

/**
 * Forme minimale d'une adresse : une part locale, une arobase, un domaine pointé, aucun espace.
 * Volontairement grossier — l'email sert d'identifiant de connexion, pas de canal d'envoi : ce qui
 * compte est qu'il soit comparable sans ambiguïté, pas qu'il soit délivrable.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Un email vide, mal formé ou dupliqué ne peut pas servir d'identifiant de connexion. */
export function isValidEmail(email: string): boolean {
  return EMAIL.test(email.trim());
}

/** Personne susceptible de partager des équipements. */
export class Member {
  private constructor(
    readonly id: string,
    readonly name: string,
    readonly email: string | null,
    /**
     * Membre qui l'a créé. Seul lien entre eux tant qu'aucun équipement ne les réunit : c'est ce
     * qui laisse l'invitant voir son invité dans l'annuaire, et lui repartager son lien de
     * première connexion, avant que le cercle n'existe.
     */
    readonly invitedById: string | null,
    /**
     * Administrateur de l'instance : le premier compte ouvert (`AuthService.bootstrap`), ou celui
     * que l'opérateur a désigné après coup sur une base antérieure à ce rôle (`admin:designate`).
     * Un seul geste en dépend — fusionner deux comptes en un —, et c'est précisément parce qu'il
     * absorbe une identité entière qu'il ne peut pas rester ouvert à tous.
     */
    readonly isAdmin: boolean,
  ) {}

  static create(props: MemberProps): Member {
    const name = props.name.trim();
    if (name.length === 0) {
      throw new DomainError('Le nom du membre est requis.');
    }
    // Champ facultatif laissé vide par un formulaire : absence d'email, pas email invalide.
    const email = props.email?.trim() ? props.email.trim() : null;
    if (email !== null && !isValidEmail(email)) {
      throw new DomainError(`Adresse email invalide : ${email}`);
    }
    return new Member(props.id, name, email, props.invitedById ?? null, props.isAdmin ?? false);
  }

  /**
   * Même compte, sous une autre identité. Sert à la fusion, où l'administrateur retient un nom et
   * un email parmi ceux des deux comptes : la validation est celle de la création, l'identifiant
   * et le rôle restent ceux du compte conservé.
   */
  withIdentity(name: string, email: string | null): Member {
    return Member.create({
      id: this.id,
      name,
      email,
      invitedById: this.invitedById,
      isAdmin: this.isAdmin,
    });
  }
}
