/**
 * Notifications push côté client : Web Push (PWA) via le service worker et une clé VAPID.
 * Le centre in-app (cloche) fonctionne indépendamment de ce canal.
 */
import { api } from './api';

/** Le navigateur supporte-t-il le Web Push ? */
export function webPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function webPushPermission(): NotificationPermission | 'unsupported' {
  if (!webPushSupported()) return 'unsupported';
  return Notification.permission;
}

/** Convertit une clé VAPID base64url en `Uint8Array` pour `pushManager.subscribe`. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/**
 * Active le Web Push : demande la permission, s'abonne auprès du navigateur et enregistre
 * l'abonnement côté serveur. Retourne `false` si non supporté / refusé / non configuré.
 */
export async function enableWebPush(): Promise<boolean> {
  if (!webPushSupported()) return false;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;

  const { publicKey } = await api.vapidPublicKey();
  if (!publicKey) return false;

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;
  await api.subscribeWebPush({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
  return true;
}

/** Désactive le Web Push : désabonne le navigateur et le serveur. */
export async function disableWebPush(): Promise<void> {
  if (!webPushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await api.unsubscribeWebPush(endpoint);
  }
}
