import { DomainError } from '../shared/domain-error.js';

export interface MemberProps {
  id: string;
  name: string;
  email?: string | null;
}

/** Personne susceptible de partager des équipements. */
export class Member {
  private constructor(
    readonly id: string,
    readonly name: string,
    readonly email: string | null,
  ) {}

  static create(props: MemberProps): Member {
    const name = props.name.trim();
    if (name.length === 0) {
      throw new DomainError('Le nom du membre est requis.');
    }
    return new Member(props.id, name, props.email ?? null);
  }
}
