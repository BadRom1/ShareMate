import { DomainError } from '../shared/domain-error.js';
import type { Money } from '../shared/money.js';

export interface ReimbursementProps {
  id: string;
  groupId: string;
  fromMemberId: string;
  toMemberId: string;
  amount: Money;
  date: Date;
  notes?: string | null;
}

/** Remboursement déclaré entre deux membres (pas de paiement intégré au MVP). */
export class Reimbursement {
  private constructor(
    readonly id: string,
    readonly groupId: string,
    readonly fromMemberId: string,
    readonly toMemberId: string,
    readonly amount: Money,
    readonly date: Date,
    readonly notes: string | null,
  ) {}

  static create(props: ReimbursementProps): Reimbursement {
    if (!props.amount.isPositive()) {
      throw new DomainError('Le montant du remboursement doit être strictement positif.');
    }
    if (props.fromMemberId === props.toMemberId) {
      throw new DomainError('Un membre ne peut pas se rembourser lui-même.');
    }
    return new Reimbursement(
      props.id,
      props.groupId,
      props.fromMemberId,
      props.toMemberId,
      props.amount,
      new Date(props.date),
      props.notes?.trim() || null,
    );
  }
}
