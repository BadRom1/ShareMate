import { DomainError } from '../shared/domain-error.js';
import { NOTIFICATION_TYPES } from './notification-type.js';
import type { NotificationType } from './notification-type.js';

export interface NotificationPreferenceProps {
  memberId: string;
  type: NotificationType;
  inApp: boolean;
  push: boolean;
}

/**
 * Préférence d'un membre pour un type d'événement : réception dans le centre in-app et/ou en push.
 * Absence de préférence stockée = tout activé (voir `NotificationService.getPreferences`).
 */
export class NotificationPreference {
  private constructor(
    readonly memberId: string,
    readonly type: NotificationType,
    readonly inApp: boolean,
    readonly push: boolean,
  ) {}

  static create(props: NotificationPreferenceProps): NotificationPreference {
    // Une préférence portant un type inconnu ne serait jamais relue (`getPreferences` parcourt
    // NOTIFICATION_TYPES) : elle n'encombrerait la table que pour donner l'illusion d'un réglage.
    if (!NOTIFICATION_TYPES.includes(props.type)) {
      throw new DomainError(`Type de notification inconnu : ${props.type}`);
    }
    return new NotificationPreference(props.memberId, props.type, props.inApp, props.push);
  }

  /** Préférence par défaut (tout activé) pour un membre et un type donnés. */
  static default(memberId: string, type: NotificationType): NotificationPreference {
    return new NotificationPreference(memberId, type, true, true);
  }
}
