/**
 * Handlers Web Push importés dans le service worker Workbox (voir `vite.config.ts` → importScripts).
 * Affiche la notification reçue et gère le clic (focus/ouverture + message au client pour la navigation).
 */
/* global self, clients */

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'ShareMate', body: event.data.text() };
  }
  const title = payload.title || 'ShareMate';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: '/pwa-192x192.png',
      badge: '/pwa-64x64.png',
      data: { link: payload.link || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '/';
  event.waitUntil(
    (async () => {
      const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if ('focus' in client) {
          client.postMessage({ type: 'notification-click', link });
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(link);
    })(),
  );
});
