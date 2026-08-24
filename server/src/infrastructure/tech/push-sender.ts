import webpush from 'web-push';
import type { WebPushError } from 'web-push';
import type { FailedTarget, PushPayload, PushSender, WebPushSubscription } from '../../application/ports.js';

/** Codes HTTP Web Push signalant un abonnement définitivement mort (à purger). */
const WEBPUSH_GONE = new Set([404, 410]);

/**
 * Envoi de push via Web Push (VAPID). Sans clés configurées, l'envoi est un no-op silencieux.
 */
export class EnvPushSender implements PushSender {
  private readonly webPushReady: boolean;

  constructor(config: { vapid?: { publicKey: string; privateKey: string; subject: string } }) {
    this.webPushReady = Boolean(config.vapid);
    if (config.vapid) {
      webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
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
}

/**
 * Construit un `PushSender` depuis l'environnement. Retourne `null` si le Web Push n'est pas
 * configuré, afin que le composition root retombe sur un no-op et journalise l'état.
 */
export function createPushSenderFromEnv(env: NodeJS.ProcessEnv): PushSender | null {
  const vapid =
    env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT
      ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT }
      : undefined;

  if (!vapid) return null;
  return new EnvPushSender({ vapid });
}
