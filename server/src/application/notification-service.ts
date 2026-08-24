import { Notification } from '../domain/notification/notification.js';
import { NotificationPreference } from '../domain/notification/preference.js';
import { NOTIFICATION_TYPES } from '../domain/notification/notification-type.js';
import type { NotificationType } from '../domain/notification/notification-type.js';
import { ForbiddenError, NotFoundError } from '../domain/shared/domain-error.js';
import type {
  Clock,
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

  /** Pousse vers les abonnements du membre et purge ceux qui sont définitivement invalides. */
  private async pushTo(memberId: string, payload: { title: string; body: string; link: string | null }): Promise<void> {
    const subs = await this.pushSubscriptions.findByMember(memberId);
    if (!subs.length) return;
    const failures = await this.pushSender.sendWebPush(subs, payload);
    await Promise.all(failures.map((f) => this.pushSubscriptions.deleteByEndpoint(memberId, f.id)));
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

  /**
   * Refuse le geste si la notification n'existe pas ou n'appartient pas au membre.
   * Celle d'un autre membre est traitée comme inexistante : même réponse qu'un identifiant
   * inconnu, sinon la distinction permettrait de les énumérer.
   */
  private async requireOwn(id: string, memberId: string): Promise<void> {
    const absent = `Notification introuvable : ${id}`;
    const existing = await this.notifications.findById(id);
    if (!existing) {
      throw new NotFoundError(absent);
    }
    if (existing.recipientId !== memberId) {
      throw new ForbiddenError(absent);
    }
  }

  async markRead(id: string, memberId: string): Promise<void> {
    await this.requireOwn(id, memberId);
    await this.notifications.markRead(id);
  }

  async markAllRead(memberId: string): Promise<void> {
    await this.notifications.markAllRead(memberId);
  }

  /**
   * Écarte définitivement une notification du centre du membre. Le geste est sans retour, mais
   * il n'emporte que l'avis : l'événement annoncé reste là où il vit (message, dépense, journal
   * du serveur). Chaque destinataire range le sien — supprimer la copie d'un membre laisse
   * intactes celles des autres.
   */
  async dismiss(id: string, memberId: string): Promise<void> {
    await this.requireOwn(id, memberId);
    await this.notifications.delete(id, memberId);
  }

  /** Vide le centre du membre. Sans effet s'il l'est déjà. */
  async dismissAll(memberId: string): Promise<void> {
    await this.notifications.deleteAll(memberId);
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
}
