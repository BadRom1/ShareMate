import type { FastifyPluginAsync } from 'fastify';
import { NOTIFICATION_TYPES } from '../../../domain/notification/notification-type.js';
import type { NotificationType } from '../../../domain/notification/notification-type.js';
import type { NotificationService, PreferenceUpdate } from '../../../application/notification-service.js';
import { notificationDto, preferenceDto } from '../dto.js';
import { arrayOf, enumOf, flag, idParams, object, text } from '../schema.js';
import '../session.js'; // augmentation de type : request.authMember

export interface NotificationRoutesOptions {
  notificationService: NotificationService;
  /** Clé publique VAPID exposée au client pour l'abonnement Web Push (null si non configurée). */
  vapidPublicKey: string | null;
}

const PREFERENCE = object({ type: enumOf(NOTIFICATION_TYPES), inApp: flag, push: flag }, ['type', 'inApp', 'push']);

/** Endpoint d'un service de push (Google, Mozilla, Apple…) : URL absolue, longue mais bornée. */
const endpoint = text(2000);

export const notificationRoutes: FastifyPluginAsync<NotificationRoutesOptions> = async (
  app,
  { notificationService, vapidPublicKey },
) => {
  app.get<{ Querystring: { unread?: string } }>(
    '/api/notifications',
    { schema: { querystring: object({ unread: enumOf(['0', '1']) }) } },
    async (request) => {
      const list = await notificationService.list(request.authMember.id, {
        unreadOnly: request.query.unread === '1',
      });
      return list.map(notificationDto);
    },
  );

  app.get('/api/notifications/unread-count', async (request) => {
    return { count: await notificationService.unreadCount(request.authMember.id) };
  });

  app.post<{ Params: { id: string } }>(
    '/api/notifications/:id/read',
    { schema: { params: idParams } },
    async (request, reply) => {
      await notificationService.markRead(request.params.id, request.authMember.id);
      return reply.status(204).send();
    },
  );

  app.post('/api/notifications/read-all', async (request, reply) => {
    await notificationService.markAllRead(request.authMember.id);
    return reply.status(204).send();
  });

  app.get('/api/notifications/preferences', async (request) => {
    const prefs = await notificationService.getPreferences(request.authMember.id);
    return prefs.map(preferenceDto);
  });

  app.put<{ Body: { preferences: { type: NotificationType; inApp: boolean; push: boolean }[] } }>(
    '/api/notifications/preferences',
    { schema: { body: object({ preferences: arrayOf(PREFERENCE, NOTIFICATION_TYPES.length) }, ['preferences']) } },
    async (request, reply) => {
      const updates: PreferenceUpdate[] = request.body.preferences;
      await notificationService.updatePreferences(request.authMember.id, updates);
      const prefs = await notificationService.getPreferences(request.authMember.id);
      return reply.send(prefs.map(preferenceDto));
    },
  );

  app.get('/api/notifications/vapid-public-key', async () => {
    return { publicKey: vapidPublicKey };
  });

  app.post<{ Body: { endpoint: string; keys: { p256dh: string; auth: string } } }>(
    '/api/notifications/subscriptions',
    {
      schema: {
        body: object({ endpoint, keys: object({ p256dh: text(200), auth: text(200) }, ['p256dh', 'auth']) }, [
          'endpoint',
          'keys',
        ]),
      },
    },
    async (request, reply) => {
      const { endpoint: url, keys } = request.body;
      await notificationService.subscribeWebPush(request.authMember.id, {
        endpoint: url,
        p256dh: keys.p256dh,
        auth: keys.auth,
      });
      return reply.status(201).send({ status: 'ok' });
    },
  );

  app.delete<{ Body: { endpoint: string } }>(
    '/api/notifications/subscriptions',
    { schema: { body: object({ endpoint }, ['endpoint']) } },
    async (request, reply) => {
      await notificationService.unsubscribeWebPush(request.body.endpoint);
      return reply.status(204).send();
    },
  );

  app.post<{ Body: { token: string; platform?: string } }>(
    '/api/notifications/device-tokens',
    { schema: { body: object({ token: text(1024), platform: text(32) }, ['token']) } },
    async (request, reply) => {
      await notificationService.registerDeviceToken(
        request.authMember.id,
        request.body.token,
        request.body.platform ?? 'android',
      );
      return reply.status(201).send({ status: 'ok' });
    },
  );

  app.delete<{ Body: { token: string } }>(
    '/api/notifications/device-tokens',
    { schema: { body: object({ token: text(1024) }, ['token']) } },
    async (request, reply) => {
      await notificationService.unregisterDeviceToken(request.body.token);
      return reply.status(204).send();
    },
  );
};
