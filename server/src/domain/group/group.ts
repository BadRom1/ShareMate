import { DomainError } from '../shared/domain-error.js';

export interface GroupProps {
  id: string;
  name: string;
  memberIds: string[];
}

/** Collectif de membres partageant des équipements. */
export class Group {
  private constructor(
    readonly id: string,
    readonly name: string,
    readonly memberIds: readonly string[],
  ) {}

  static create(props: GroupProps): Group {
    const name = props.name.trim();
    if (name.length === 0) {
      throw new DomainError('Le nom du groupe est requis.');
    }
    const memberIds = [...new Set(props.memberIds)];
    if (memberIds.length === 0) {
      throw new DomainError('Un groupe doit compter au moins un membre.');
    }
    return new Group(props.id, name, memberIds);
  }

  hasMember(memberId: string): boolean {
    return this.memberIds.includes(memberId);
  }

  addMember(memberId: string): Group {
    return Group.create({ id: this.id, name: this.name, memberIds: [...this.memberIds, memberId] });
  }

  removeMember(memberId: string): Group {
    const remaining = this.memberIds.filter((m) => m !== memberId);
    if (remaining.length === this.memberIds.length) {
      throw new DomainError('Ce membre ne fait pas partie du groupe.');
    }
    return Group.create({ id: this.id, name: this.name, memberIds: remaining });
  }
}
