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
    return new NotificationPreference(props.memberId, props.type, props.inApp, props.push);
  }

  /** Préférence par défaut (tout activé) pour un membre et un type donnés. */
  static default(memberId: string, type: NotificationType): NotificationPreference {
    return new NotificationPreference(memberId, type, true, true);
  }
}
