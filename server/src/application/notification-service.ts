import { Notification } from '../domain/notification/notification.js';
import { NotificationPreference } from '../domain/notification/preference.js';
import { NOTIFICATION_TYPES } from '../domain/notification/notification-type.js';
import type { NotificationType } from '../domain/notification/notification-type.js';
import { ForbiddenError, NotFoundError } from '../domain/shared/domain-error.js';
import type {
  Clock,
  DeviceTokenRepository,
  IdGenerator,
  Notifier,
  NotifyEvent,
  NotificationPreferenceRepository,
  NotificationRepository,
  PushSender,
  PushSubscriptionRepository,
} from './ports.js';

export interface PreferenceUpdate {
  type: NotificationType;
  inApp: boolean;
  push: boolean;
}

/**
 * Cœur du système de notifications. Implémente `Notifier` (appelé par les producteurs)
 * et expose la lecture, les préférences et l'enregistrement des canaux push.
 */
export class NotificationService implements Notifier {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly preferences: NotificationPreferenceRepository,
    private readonly pushSubscriptions: PushSubscriptionRepository,
    private readonly deviceTokens: DeviceTokenRepository,
    private readonly pushSender: PushSender,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async notify(event: NotifyEvent): Promise<void> {
    for (const recipientId of new Set(event.recipientIds)) {
      const pref = await this.preferenceFor(recipientId, event.type);
      if (pref.inApp) {
        await this.notifications.save(
          Notification.create({
            id: this.idGenerator.next(),
            recipientId,
            type: event.type,
            title: event.title,
            body: event.body,
            link: event.link ?? null,
            createdAt: this.clock.now(),
          }),
        );
      }
      if (pref.push) {
        await this.pushTo(recipientId, { title: event.title, body: event.body, link: event.link ?? null });
      }
    }
  }

  /** Pousse vers tous les canaux du membre et purge les abonnements définitivement invalides. */
  private async pushTo(memberId: string, payload: { title: string; body: string; link: string | null }): Promise<void> {
    const [subs, tokens] = await Promise.all([
      this.pushSubscriptions.findByMember(memberId),
      this.deviceTokens.findByMember(memberId),
    ]);
    const [webFailures, fcmFailures] = await Promise.all([
      subs.length ? this.pushSender.sendWebPush(subs, payload) : Promise.resolve([]),
      tokens.length ? this.pushSender.sendFcm(tokens, payload) : Promise.resolve([]),
    ]);
    await Promise.all(webFailures.map((f) => this.pushSubscriptions.deleteByEndpoint(memberId, f.id)));
    await Promise.all(fcmFailures.map((f) => this.deviceTokens.deleteByToken(memberId, f.id)));
  }

  private async preferenceFor(memberId: string, type: NotificationType): Promise<NotificationPreference> {
    const stored = await this.preferences.findByMember(memberId);
    return stored.find((p) => p.type === type) ?? NotificationPreference.default(memberId, type);
  }

  async list(memberId: string, options?: { unreadOnly?: boolean; limit?: number }): Promise<Notification[]> {
    return this.notifications.findByRecipient(memberId, options);
  }

  async unreadCount(memberId: string): Promise<number> {
    return this.notifications.countUnread(memberId);
  }

  async markRead(id: string, memberId: string): Promise<void> {
    // La notification d'un autre membre est traitée comme inexistante : même réponse
    // qu'un identifiant inconnu, sinon la distinction permettrait de les énumérer.
    const absent = `Notification introuvable : ${id}`;
    const existing = await this.notifications.findById(id);
    if (!existing) {
      throw new NotFoundError(absent);
    }
    if (existing.recipientId !== memberId) {
      throw new ForbiddenError(absent);
    }
    await this.notifications.markRead(id);
  }

  async markAllRead(memberId: string): Promise<void> {
    await this.notifications.markAllRead(memberId);
  }

  /** Préférences complètes du membre (défauts fusionnés avec les valeurs stockées), un item par type. */
  async getPreferences(memberId: string): Promise<NotificationPreference[]> {
    const stored = await this.preferences.findByMember(memberId);
    return NOTIFICATION_TYPES.map(
      (type) => stored.find((p) => p.type === type) ?? NotificationPreference.default(memberId, type),
    );
  }

  async updatePreferences(memberId: string, updates: PreferenceUpdate[]): Promise<void> {
    for (const update of updates) {
      await this.preferences.upsert(
        NotificationPreference.create({ memberId, type: update.type, inApp: update.inApp, push: update.push }),
      );
    }
  }

  async subscribeWebPush(memberId: string, sub: { endpoint: string; p256dh: string; auth: string }): Promise<void> {
    await this.pushSubscriptions.save({ ...sub, memberId });
  }

  /**
   * Désabonne un canal du membre. L'endpoint (comme le jeton d'appareil) est un identifiant qui
   * circule — il transite par le service de push, il apparaît dans les journaux — et il ne prouve
   * rien : seul le rapprochement avec la session dit qui a le droit de couper ce canal. Sans lui,
   * le connaître suffisait à faire taire les alertes d'un tiers, à commencer par celles qui
   * signalent son éviction d'un cercle. Le résultat est le même que l'endpoint ait existé ou non :
   * la réponse ne doit pas dire à qui il appartient.
   */
  async unsubscribeWebPush(memberId: string, endpoint: string): Promise<void> {
    await this.pushSubscriptions.deleteByEndpoint(memberId, endpoint);
  }

  async registerDeviceToken(memberId: string, token: string, platform: string): Promise<void> {
    await this.deviceTokens.save({ token, memberId, platform });
  }

  async unregisterDeviceToken(memberId: string, token: string): Promise<void> {
    await this.deviceTokens.deleteByToken(memberId, token);
  }
}
