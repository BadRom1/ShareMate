import { DomainError } from '../shared/domain-error.js';

export interface MemberProps {
  id: string;
  name: string;
  email?: string | null;
  invitedById?: string | null;
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
    return new Member(props.id, name, props.email ?? null, props.invitedById ?? null);
  }
}
