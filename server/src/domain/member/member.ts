import { DomainError } from '../shared/domain-error.js';

export interface MemberProps {
  id: string;
  name: string;
  email?: string | null;
  invitedById?: string | null;
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
    return new Member(props.id, name, email, props.invitedById ?? null);
  }
}
