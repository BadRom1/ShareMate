import webpush from 'web-push';
import type { WebPushError } from 'web-push';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import type { ServiceAccount } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { Messaging } from 'firebase-admin/messaging';
import type {
  DeviceToken,
  FailedTarget,
  PushPayload,
  PushSender,
  WebPushSubscription,
} from '../../application/ports.js';

/** Codes HTTP Web Push signalant un abonnement définitivement mort (à purger). */
const WEBPUSH_GONE = new Set([404, 410]);

/** Codes d'erreur FCM signalant un jeton définitivement invalide (à purger). */
const FCM_GONE = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

/**
 * Envoi de push via Web Push (VAPID) et FCM. Chaque canal se désactive indépendamment
 * si sa configuration est absente : sans clés, l'envoi est un no-op silencieux.
 */
export class EnvPushSender implements PushSender {
  private readonly webPushReady: boolean;
  private readonly messaging: Messaging | null;

  constructor(config: {
    vapid?: { publicKey: string; privateKey: string; subject: string };
    fcmServiceAccount?: ServiceAccount;
  }) {
    this.webPushReady = Boolean(config.vapid);
    if (config.vapid) {
      webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
    }
    if (config.fcmServiceAccount) {
      const app = getApps().length > 0 ? getApps()[0]! : initializeApp({ credential: cert(config.fcmServiceAccount) });
      this.messaging = getMessaging(app);
    } else {
      this.messaging = null;
    }
  }

  async sendWebPush(subscriptions: WebPushSubscription[], payload: PushPayload): Promise<FailedTarget[]> {
    if (!this.webPushReady) return [];
    const body = JSON.stringify(payload);
    const failed: FailedTarget[] = [];
    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body,
          );
        } catch (error) {
          const statusCode = (error as WebPushError).statusCode;
          if (statusCode && WEBPUSH_GONE.has(statusCode)) {
            failed.push({ id: sub.endpoint });
          }
        }
      }),
    );
    return failed;
  }

  async sendFcm(tokens: DeviceToken[], payload: PushPayload): Promise<FailedTarget[]> {
    if (!this.messaging || tokens.length === 0) return [];
    const tokenValues = tokens.map((t) => t.token);
    const response = await this.messaging.sendEachForMulticast({
      tokens: tokenValues,
      notification: { title: payload.title, body: payload.body },
      data: payload.link ? { link: payload.link } : {},
    });
    const failed: FailedTarget[] = [];
    response.responses.forEach((res, i) => {
      const token = tokenValues[i];
      if (token && !res.success && res.error && FCM_GONE.has(res.error.code)) {
        failed.push({ id: token });
      }
    });
    return failed;
  }
}

/**
 * Construit un `PushSender` depuis l'environnement. Retourne `null` si aucun canal n'est configuré,
 * afin que le composition root retombe sur un no-op et journalise l'état.
 */
export function createPushSenderFromEnv(env: NodeJS.ProcessEnv): PushSender | null {
  const vapid =
    env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT
      ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT }
      : undefined;

  let fcmServiceAccount: ServiceAccount | undefined;
  if (env.FCM_SERVICE_ACCOUNT) {
    try {
      fcmServiceAccount = JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;
    } catch {
      throw new Error('FCM_SERVICE_ACCOUNT doit être un JSON de compte de service valide.');
    }
  }

  if (!vapid && !fcmServiceAccount) return null;
  return new EnvPushSender({ vapid, fcmServiceAccount });
}
