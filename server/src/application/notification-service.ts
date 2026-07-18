import { Notification } from '../domain/notification/notification.js';
import { NotificationPreference } from '../domain/notification/preference.js';
import { NOTIFICATION_TYPES } from '../domain/notification/notification-type.js';
import type { NotificationType } from '../domain/notification/notification-type.js';
import { NotFoundError, UnauthorizedError } from '../domain/shared/domain-error.js';
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
    await Promise.all(webFailures.map((f) => this.pushSubscriptions.deleteByEndpoint(f.id)));
    await Promise.all(fcmFailures.map((f) => this.deviceTokens.deleteByToken(f.id)));
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
    const existing = await this.notifications.findById(id);
    if (!existing) {
      throw new NotFoundError(`Notification introuvable : ${id}`);
    }
    if (existing.recipientId !== memberId) {
      throw new UnauthorizedError('Notification appartenant à un autre membre.');
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

  async unsubscribeWebPush(endpoint: string): Promise<void> {
    await this.pushSubscriptions.deleteByEndpoint(endpoint);
  }

  async registerDeviceToken(memberId: string, token: string, platform: string): Promise<void> {
    await this.deviceTokens.save({ token, memberId, platform });
  }

  async unregisterDeviceToken(token: string): Promise<void> {
    await this.deviceTokens.deleteByToken(token);
  }
}
