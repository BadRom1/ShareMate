import { beforeEach, describe, expect, it } from 'vitest';
import { NotificationService } from './notification-service.js';
import { NotificationPreference } from '../domain/notification/preference.js';
import { UnauthorizedError } from '../domain/shared/domain-error.js';
import type { DeviceToken, FailedTarget, PushPayload, PushSender, WebPushSubscription } from './ports.js';
import {
  FixedClock,
  InMemoryDeviceTokenRepository,
  InMemoryNotificationPreferenceRepository,
  InMemoryNotificationRepository,
  InMemoryPushSubscriptionRepository,
  NoopPushSender,
  SequentialIdGenerator,
} from './testing/in-memory.js';

/** PushSender qui enregistre les envois et peut simuler des cibles mortes. */
class RecordingPushSender implements PushSender {
  webCalls: WebPushSubscription[][] = [];
  fcmCalls: DeviceToken[][] = [];
  constructor(private readonly failWebEndpoints: string[] = []) {}
  async sendWebPush(subs: WebPushSubscription[], _payload: PushPayload): Promise<FailedTarget[]> {
    this.webCalls.push(subs);
    return subs.filter((s) => this.failWebEndpoints.includes(s.endpoint)).map((s) => ({ id: s.endpoint }));
  }
  async sendFcm(tokens: DeviceToken[], _payload: PushPayload): Promise<FailedTarget[]> {
    this.fcmCalls.push(tokens);
    return [];
  }
}

function makeService(pushSender: PushSender = new NoopPushSender()) {
  const notifications = new InMemoryNotificationRepository();
  const preferences = new InMemoryNotificationPreferenceRepository();
  const subs = new InMemoryPushSubscriptionRepository();
  const tokens = new InMemoryDeviceTokenRepository();
  const service = new NotificationService(
    notifications,
    preferences,
    subs,
    tokens,
    pushSender,
    new SequentialIdGenerator('n'),
    new FixedClock(new Date('2026-07-02T10:00:00Z')),
  );
  return { service, notifications, preferences, subs, tokens };
}

describe('NotificationService', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
  });

  it('persiste une notification in-app par destinataire (préférence par défaut)', async () => {
    await ctx.service.notify({ type: 'MESSAGE_POSTED', recipientIds: ['m1', 'm2'], title: 'T', body: 'B' });
    expect(await ctx.service.unreadCount('m1')).toBe(1);
    expect(await ctx.service.unreadCount('m2')).toBe(1);
  });

  it('ne persiste pas quand inApp est désactivé', async () => {
    await ctx.preferences.upsert(
      NotificationPreference.create({ memberId: 'm1', type: 'MESSAGE_POSTED', inApp: false, push: false }),
    );
    await ctx.service.notify({ type: 'MESSAGE_POSTED', recipientIds: ['m1'], title: 'T', body: 'B' });
    expect(await ctx.service.unreadCount('m1')).toBe(0);
  });

  it('marque lu et empêche de lire la notification d’un autre membre', async () => {
    await ctx.service.notify({ type: 'EXPENSE_ADDED', recipientIds: ['m1'], title: 'T', body: 'B' });
    const [notif] = await ctx.service.list('m1');
    await expect(ctx.service.markRead(notif!.id, 'm2')).rejects.toThrow(UnauthorizedError);
    await ctx.service.markRead(notif!.id, 'm1');
    expect(await ctx.service.unreadCount('m1')).toBe(0);
  });

  it('pousse en Web Push et purge les abonnements morts', async () => {
    const sender = new RecordingPushSender(['dead-endpoint']);
    const c = makeService(sender);
    await c.subs.save({ endpoint: 'dead-endpoint', memberId: 'm1', p256dh: 'p', auth: 'a' });
    await c.subs.save({ endpoint: 'live-endpoint', memberId: 'm1', p256dh: 'p', auth: 'a' });
    await c.service.notify({ type: 'MESSAGE_POSTED', recipientIds: ['m1'], title: 'T', body: 'B' });
    expect(sender.webCalls).toHaveLength(1);
    const remaining = await c.subs.findByMember('m1');
    expect(remaining.map((s) => s.endpoint)).toEqual(['live-endpoint']);
  });

  it('retourne des préférences complètes (défaut = tout activé)', async () => {
    const prefs = await ctx.service.getPreferences('m1');
    expect(prefs.length).toBeGreaterThanOrEqual(5);
    expect(prefs.every((p) => p.inApp && p.push)).toBe(true);
  });
});
