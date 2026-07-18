import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ConflictError, DomainError, NotFoundError, UnauthorizedError } from '../../domain/shared/domain-error.js';
import type { Member } from '../../domain/member/member.js';
import type { ExpenseCategory } from '../../domain/expense/expense.js';
import type { ReservationStatus } from '../../domain/reservation/reservation.js';
import type { RecurrenceFrequency } from '../../domain/reservation/recurrence.js';
import { MemberService } from '../../application/member-service.js';
import { AuthService } from '../../application/auth-service.js';
import type { AuthSession } from '../../application/auth-service.js';
import { EquipmentService } from '../../application/equipment-service.js';
import { ReservationService } from '../../application/reservation-service.js';
import { UsageService } from '../../application/usage-service.js';
import { ExpenseService } from '../../application/expense-service.js';
import type { SplitInput } from '../../application/expense-service.js';
import { DiscussionService } from '../../application/discussion-service.js';
import { NotificationService } from '../../application/notification-service.js';
import type { PreferenceUpdate } from '../../application/notification-service.js';
import type { NotificationType } from '../../domain/notification/notification-type.js';
import type {
  Clock,
  CredentialRepository,
  DeviceTokenRepository,
  EquipmentRepository,
  ExpenseRepository,
  IdGenerator,
  MemberRepository,
  MessageRepository,
  ThreadRepository,
  NotificationPreferenceRepository,
  NotificationRepository,
  PasswordHasher,
  PushSender,
  PushSubscriptionRepository,
  ReimbursementRepository,
  ReservationRepository,
  SessionRepository,
  TokenGenerator,
  UsageRecordRepository,
} from '../../application/ports.js';
import {
  equipmentDto,
  expenseDto,
  memberDto,
  messageDto,
  threadDto,
  threadSummaryDto,
  notificationDto,
  preferenceDto,
  reimbursementDto,
  reservationDto,
  reservationListDto,
  usageRecordDto,
} from './dto.js';

export interface AppDependencies {
  members: MemberRepository;
  equipments: EquipmentRepository;
  reservations: ReservationRepository;
  usageRecords: UsageRecordRepository;
  expenses: ExpenseRepository;
  reimbursements: ReimbursementRepository;
  threads: ThreadRepository;
  messages: MessageRepository;
  notifications: NotificationRepository;
  notificationPreferences: NotificationPreferenceRepository;
  pushSubscriptions: PushSubscriptionRepository;
  deviceTokens: DeviceTokenRepository;
  credentials: CredentialRepository;
  sessions: SessionRepository;
  passwordHasher: PasswordHasher;
  tokenGenerator: TokenGenerator;
  idGenerator: IdGenerator;
  clock: Clock;
  /** Cookie de session en `Secure` (obligatoire derrière HTTPS en production). */
  cookieSecure?: boolean;
  /** Logger Fastify (false par défaut pour les tests, pino en production). */
  logger?: FastifyServerOptions['logger'];
  /** Fait confiance aux en-têtes X-Forwarded-* (obligatoire derrière le proxy Railway pour le rate-limit par IP). */
  trustProxy?: boolean;
  /** Répertoire de stockage des justificatifs (null = upload désactivé). */
  uploadsDir?: string | null;
  /** Répertoire des fichiers statiques du front (null = API seule). */
  webDistDir?: string | null;
  /**
   * Origines autorisées en cross-origin (app native Capacitor). Vide = pas de CORS
   * (le front web est servi en même-origine et n'en a pas besoin).
   */
  corsOrigins?: string[];
  /** Envoi de push (Web Push + FCM). Absent = push désactivé, seul le centre in-app fonctionne. */
  pushSender?: PushSender;
  /** Clé publique VAPID exposée au client pour l'abonnement Web Push (null si non configurée). */
  vapidPublicKey?: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Membre authentifié, posé par le hook de session sur les routes protégées. */
    authMember: Member;
  }
  interface FastifyContextConfig {
    /** Route accessible sans session (login, invitation, santé…). */
    public?: boolean;
  }
}

const SESSION_COOKIE = 'sharemate_session';

/** En-tête posé par l'app native pour recevoir le token de session dans le corps. */
const CLIENT_HEADER = 'x-sharemate-client';

/** Limite anti force-brute des routes d'authentification publiques. */
const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

/**
 * Token de session, depuis le cookie (web) ou l'en-tête `Authorization: Bearer` (app native,
 * où les cookies cross-origin ne sont pas fiables en WebView).
 */
function sessionToken(request: FastifyRequest): string | undefined {
  const cookieToken = request.cookies[SESSION_COOKIE];
  if (cookieToken) return cookieToken;
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token) return token;
  }
  return undefined;
}

/** L'app native s'annonce pour recevoir le token de session (le web reste sur cookie httpOnly). */
function isNativeClient(request: FastifyRequest): boolean {
  return request.headers[CLIENT_HEADER] === 'native';
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: deps.trustProxy ?? false });

  const corsOrigins = deps.corsOrigins ?? [];
  const corsEnabled = corsOrigins.length > 0;

  await app.register(helmet, {
    // L'app native lit l'API en cross-origin : la politique par défaut (same-origin)
    // bloquerait ces lectures. Relâché uniquement quand des origines CORS sont configurées.
    crossOriginResourcePolicy: corsEnabled ? { policy: 'cross-origin' } : undefined,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // 'unsafe-inline' : requis pour les attributs style= posés par React.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // Désactivé : casserait l'accès en HTTP simple (réseau local) ; Railway force déjà HTTPS.
        upgradeInsecureRequests: null,
      },
    },
  });
  await app.register(cookie);
  if (corsEnabled) {
    // Auth par token Bearer côté natif : pas de cookie cross-origin, donc pas de `credentials`.
    await app.register(cors, {
      origin: corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', CLIENT_HEADER],
    });
  }
  // Chargé avant la déclaration des routes, sinon son hook onRoute ne s'applique pas.
  await app.register(rateLimit, { global: false });

  const noopPushSender: PushSender = {
    async sendWebPush() {
      return [];
    },
    async sendFcm() {
      return [];
    },
  };
  const notificationService = new NotificationService(
    deps.notifications,
    deps.notificationPreferences,
    deps.pushSubscriptions,
    deps.deviceTokens,
    deps.pushSender ?? noopPushSender,
    deps.idGenerator,
    deps.clock,
  );

  const authService = new AuthService(
    deps.members,
    deps.credentials,
    deps.sessions,
    deps.passwordHasher,
    deps.tokenGenerator,
    deps.idGenerator,
    deps.clock,
  );
  const memberService = new MemberService(deps.members, deps.idGenerator);
  const equipmentService = new EquipmentService(deps.equipments, deps.members, deps.idGenerator);
  const reservationService = new ReservationService(
    deps.reservations,
    deps.equipments,
    deps.idGenerator,
    deps.clock,
    deps.members,
    notificationService,
  );
  const usageService = new UsageService(
    deps.usageRecords,
    deps.equipments,
    deps.idGenerator,
    deps.clock,
    notificationService,
  );
  const expenseService = new ExpenseService(
    deps.expenses,
    deps.reimbursements,
    deps.equipments,
    deps.reservations,
    deps.idGenerator,
    deps.members,
    notificationService,
  );
  const discussionService = new DiscussionService(
    deps.threads,
    deps.messages,
    deps.equipments,
    deps.members,
    deps.idGenerator,
    deps.clock,
    notificationService,
  );

  function setSessionCookie(reply: FastifyReply, session: AuthSession): void {
    reply.setCookie(SESSION_COOKIE, session.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.cookieSecure ?? false,
      expires: session.expiresAt,
    });
  }

  /**
   * Établit la session : cookie (web) et, pour l'app native, le token dans le corps pour
   * qu'elle le stocke et le renvoie ensuite en `Authorization: Bearer`.
   */
  function authenticated(request: FastifyRequest, reply: FastifyReply, member: Member, session: AuthSession) {
    setSessionCookie(reply, session);
    const body: { member: ReturnType<typeof memberDto>; token?: string } = { member: memberDto(member) };
    if (isNativeClient(request)) {
      body.token = session.token;
    }
    return body;
  }

  // Toute route /api/* ou /uploads/* exige une session, sauf celles marquées `config.public`.
  app.decorateRequest('authMember', null as unknown as Member);
  app.addHook('onRequest', async (request, reply) => {
    const url = request.raw.url ?? '';
    if (!url.startsWith('/api/') && !url.startsWith('/uploads/')) {
      return; // front statique : l'écran de connexion doit rester accessible
    }
    if (request.routeOptions?.config?.public) {
      return;
    }
    const token = sessionToken(request);
    const member = token ? await authService.authenticate(token) : null;
    if (!member) {
      return reply.status(401).send({ error: 'Authentification requise.' });
    }
    request.authMember = member;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof UnauthorizedError) {
      return reply.status(401).send({ error: error.message });
    }
    if (error instanceof ConflictError) {
      return reply.status(409).send({ error: error.message });
    }
    if (error instanceof NotFoundError) {
      return reply.status(404).send({ error: error.message });
    }
    if (error instanceof DomainError) {
      return reply.status(400).send({ error: error.message });
    }
    const httpError = error as { validation?: unknown; statusCode?: number; message?: string };
    if (httpError.validation || (httpError.statusCode && httpError.statusCode < 500)) {
      return reply.status(httpError.statusCode ?? 400).send({ error: httpError.message ?? 'Requête invalide.' });
    }
    app.log.error(error);
    return reply.status(500).send({ error: 'Erreur interne du serveur.' });
  });

  app.get('/api/health', { config: { public: true } }, async () => ({ status: 'ok' }));

  // --- Authentification ---

  app.get('/api/auth/me', { config: { public: true } }, async (request) => {
    const token = sessionToken(request);
    const member = token ? await authService.authenticate(token) : null;
    return {
      member: member ? memberDto(member) : null,
      needsBootstrap: await authService.needsBootstrap(),
    };
  });

  app.post<{ Body: { name: string; email?: string | null; password: string } }>(
    '/api/auth/bootstrap',
    { config: { public: true, rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      const { member, session } = await authService.bootstrap(request.body);
      return reply.status(201).send(authenticated(request, reply, member, session));
    },
  );

  app.post<{ Body: { identifier: string; password: string } }>(
    '/api/auth/login',
    { config: { public: true, rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      const { member, session } = await authService.login(request.body.identifier, request.body.password);
      return reply.send(authenticated(request, reply, member, session));
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const token = sessionToken(request);
    if (token) {
      await authService.logout(token);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get<{ Params: { code: string } }>(
    '/api/auth/invites/:code',
    { config: { public: true, rateLimit: AUTH_RATE_LIMIT } },
    async (request) => {
      const member = await authService.inviteInfo(request.params.code);
      return { memberName: member.name };
    },
  );

  app.post<{ Params: { code: string }; Body: { password: string } }>(
    '/api/auth/invites/:code/redeem',
    { config: { public: true, rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      const { member, session } = await authService.redeemInvite(request.params.code, request.body.password);
      return reply.send(authenticated(request, reply, member, session));
    },
  );

  app.post<{ Body: { currentPassword: string; newPassword: string } }>('/api/auth/password', async (request, reply) => {
    await authService.changePassword(request.authMember.id, request.body.currentPassword, request.body.newPassword);
    return reply.status(204).send();
  });

  // --- Membres (utilisateurs globaux, portés par les équipements) ---

  app.post<{ Body: { name: string; email?: string | null } }>('/api/members', async (request, reply) => {
    const { member, inviteCode } = await authService.createMemberWithInvite(request.body);
    return reply.status(201).send({ ...memberDto(member), inviteCode });
  });

  app.post<{ Params: { id: string } }>('/api/members/:id/invite', async (request, reply) => {
    const inviteCode = await authService.regenerateInvite(request.params.id);
    return reply.status(201).send({ inviteCode });
  });

  app.get('/api/members', async () => {
    const members = await memberService.listMembers();
    return members.map(memberDto);
  });

  // --- Équipements ---

  app.post<{
    Body: {
      name: string;
      category: string;
      acquisitionDate: string;
      purchaseValueEuros: number;
      meterUnit: 'HOURS' | 'KILOMETERS';
      memberIds: string[];
      maintenanceThreshold?: number | null;
    };
  }>('/api/equipments', async (request, reply) => {
    const equipment = await equipmentService.create({
      ...request.body,
      maintenanceThreshold: request.body.maintenanceThreshold ?? null,
    });
    return reply.status(201).send(equipmentDto(equipment));
  });

  app.get('/api/equipments', async () => {
    const list = await equipmentService.list();
    return list.map(equipmentDto);
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id', async (request) => {
    return equipmentDto(await equipmentService.getById(request.params.id));
  });

  app.put<{
    Params: { id: string };
    Body: Partial<{
      name: string;
      category: string;
      acquisitionDate: string;
      purchaseValueEuros: number;
      meterUnit: 'HOURS' | 'KILOMETERS';
      memberIds: string[];
      maintenanceThreshold: number | null;
    }>;
  }>('/api/equipments/:id', async (request) => {
    return equipmentDto(await equipmentService.update(request.params.id, request.body));
  });

  app.delete<{ Params: { id: string } }>('/api/equipments/:id', async (request, reply) => {
    await equipmentService.delete(request.params.id);
    return reply.status(204).send();
  });

  // --- Réservations ---

  app.post<{
    Body: {
      equipmentId: string;
      start: string;
      end: string;
      status?: ReservationStatus;
      notes?: string | null;
    };
  }>('/api/reservations', async (request, reply) => {
    const { reservation, conflicts } = await reservationService.reserve({
      ...request.body,
      memberId: request.authMember.id,
    });
    return reply.status(201).send(
      reservationDto(
        reservation,
        conflicts.map((c) => c.id),
      ),
    );
  });

  app.post<{
    Body: {
      equipmentId: string;
      start: string;
      end: string;
      status?: ReservationStatus;
      notes?: string | null;
      frequency: RecurrenceFrequency;
      until: string;
    };
  }>('/api/reservations/recurring', async (request, reply) => {
    const { frequency, until, ...input } = request.body;
    const results = await reservationService.reserveRecurring(
      { ...input, memberId: request.authMember.id },
      { frequency, until },
    );
    return reply.status(201).send(
      results.map(({ reservation, conflicts }) =>
        reservationDto(
          reservation,
          conflicts.map((c) => c.id),
        ),
      ),
    );
  });

  app.put<{
    Params: { id: string };
    Body: { start?: string; end?: string; status?: ReservationStatus; notes?: string | null };
  }>('/api/reservations/:id', async (request) => {
    const { reservation, conflicts } = await reservationService.update(request.params.id, request.body);
    return reservationDto(
      reservation,
      conflicts.map((c) => c.id),
    );
  });

  app.delete<{ Params: { id: string } }>('/api/reservations/:id', async (request, reply) => {
    await reservationService.cancel(request.params.id);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id/reservations', async (request) => {
    return reservationListDto(await reservationService.listByEquipment(request.params.id));
  });

  app.get('/api/calendar', async () => {
    return reservationListDto(await reservationService.calendar());
  });

  // --- Suivi d'usage et maintenance ---

  app.post<{
    Body: {
      equipmentId: string;
      meterReading?: number | null;
      duration?: number | null;
      fuelAddedLiters?: number | null;
      notes?: string | null;
      isMaintenance?: boolean;
    };
  }>('/api/usage', async (request, reply) => {
    const entry = await usageService.recordUsage({ ...request.body, memberId: request.authMember.id });
    return reply.status(201).send(usageRecordDto(entry.record, entry.duration));
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id/usage', async (request) => {
    const list = await usageService.historyByEquipment(request.params.id);
    return list.map((e) => usageRecordDto(e.record, e.duration));
  });

  app.get<{ Params: { id: string } }>('/api/members/:id/usage', async (request) => {
    const list = await usageService.historyByMember(request.params.id);
    return list.map((e) => usageRecordDto(e.record, e.duration));
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id/maintenance', async (request) => {
    return usageService.maintenanceStatus(request.params.id);
  });

  app.get('/api/alerts', async () => {
    return usageService.alerts();
  });

  // --- Dépenses, soldes, remboursements ---

  app.post<{
    Body: {
      equipmentId: string;
      label: string;
      amountEuros: number;
      payerId: string;
      date: string;
      category: ExpenseCategory;
      split: SplitInput;
      receiptPath?: string | null;
    };
  }>('/api/expenses', async (request, reply) => {
    const expense = await expenseService.addExpense(request.body);
    return reply.status(201).send(expenseDto(expense));
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id/expenses', async (request) => {
    const list = await expenseService.listExpenses(request.params.id);
    return list.map(expenseDto);
  });

  app.delete<{ Params: { id: string } }>('/api/expenses/:id', async (request, reply) => {
    await expenseService.deleteExpense(request.params.id);
    return reply.status(204).send();
  });

  app.post<{
    Body: {
      equipmentId: string;
      fromMemberId: string;
      toMemberId: string;
      amountEuros: number;
      date: string;
      notes?: string | null;
    };
  }>('/api/reimbursements', async (request, reply) => {
    const reimbursement = await expenseService.recordReimbursement(request.body);
    return reply.status(201).send(reimbursementDto(reimbursement));
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id/reimbursements', async (request) => {
    const list = await expenseService.listReimbursements(request.params.id);
    return list.map(reimbursementDto);
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id/balances', async (request) => {
    const balances = await expenseService.equipmentBalances(request.params.id);
    return balances.map((b) => ({ memberId: b.memberId, balanceEuros: b.balanceCents / 100 }));
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id/settlement', async (request) => {
    const plan = await expenseService.settlementPlan(request.params.id);
    return plan.map((t) => ({
      fromMemberId: t.fromMemberId,
      toMemberId: t.toMemberId,
      amountEuros: t.amountCents / 100,
    }));
  });

  // --- Discussions par équipement (fils + messages) ---

  app.get<{ Params: { id: string } }>('/api/equipments/:id/threads', async (request) => {
    const list = await discussionService.listThreads(request.params.id);
    return list.map(threadSummaryDto);
  });

  app.post<{ Body: { equipmentId: string; title: string; body?: string | null } }>(
    '/api/threads',
    async (request, reply) => {
      const thread = await discussionService.createThread({
        equipmentId: request.body.equipmentId,
        authorId: request.authMember.id,
        title: request.body.title,
        body: request.body.body ?? null,
      });
      return reply.status(201).send(threadDto(thread));
    },
  );

  app.put<{ Params: { id: string }; Body: { title: string } }>('/api/threads/:id', async (request) => {
    const thread = await discussionService.renameThread(request.params.id, request.authMember.id, request.body.title);
    return threadDto(thread);
  });

  app.delete<{ Params: { id: string } }>('/api/threads/:id', async (request, reply) => {
    await discussionService.deleteThread(request.params.id, request.authMember.id);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/threads/:id/messages', async (request) => {
    const list = await discussionService.listMessages(request.params.id);
    return list.map(messageDto);
  });

  app.post<{ Body: { threadId: string; body: string } }>('/api/messages', async (request, reply) => {
    const message = await discussionService.postMessage({
      threadId: request.body.threadId,
      authorId: request.authMember.id,
      body: request.body.body,
    });
    return reply.status(201).send(messageDto(message));
  });

  app.put<{ Params: { id: string }; Body: { body: string } }>('/api/messages/:id', async (request) => {
    const message = await discussionService.editMessage(request.params.id, request.authMember.id, request.body.body);
    return messageDto(message);
  });

  app.delete<{ Params: { id: string } }>('/api/messages/:id', async (request, reply) => {
    await discussionService.deleteMessage(request.params.id, request.authMember.id);
    return reply.status(204).send();
  });

  // --- Notifications ---

  app.get<{ Querystring: { unread?: string } }>('/api/notifications', async (request) => {
    const list = await notificationService.list(request.authMember.id, {
      unreadOnly: request.query.unread === '1',
    });
    return list.map(notificationDto);
  });

  app.get('/api/notifications/unread-count', async (request) => {
    return { count: await notificationService.unreadCount(request.authMember.id) };
  });

  app.post<{ Params: { id: string } }>('/api/notifications/:id/read', async (request, reply) => {
    await notificationService.markRead(request.params.id, request.authMember.id);
    return reply.status(204).send();
  });

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
    async (request, reply) => {
      const updates: PreferenceUpdate[] = request.body.preferences ?? [];
      await notificationService.updatePreferences(request.authMember.id, updates);
      const prefs = await notificationService.getPreferences(request.authMember.id);
      return reply.send(prefs.map(preferenceDto));
    },
  );

  app.get('/api/notifications/vapid-public-key', async () => {
    return { publicKey: deps.vapidPublicKey ?? null };
  });

  app.post<{ Body: { endpoint: string; keys: { p256dh: string; auth: string } } }>(
    '/api/notifications/subscriptions',
    async (request, reply) => {
      const { endpoint, keys } = request.body;
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return reply.status(400).send({ error: 'Abonnement Web Push incomplet.' });
      }
      await notificationService.subscribeWebPush(request.authMember.id, {
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      });
      return reply.status(201).send({ status: 'ok' });
    },
  );

  app.delete<{ Body: { endpoint: string } }>('/api/notifications/subscriptions', async (request, reply) => {
    await notificationService.unsubscribeWebPush(request.body.endpoint);
    return reply.status(204).send();
  });

  app.post<{ Body: { token: string; platform?: string } }>(
    '/api/notifications/device-tokens',
    async (request, reply) => {
      if (!request.body.token) {
        return reply.status(400).send({ error: 'Jeton d’appareil manquant.' });
      }
      await notificationService.registerDeviceToken(
        request.authMember.id,
        request.body.token,
        request.body.platform ?? 'android',
      );
      return reply.status(201).send({ status: 'ok' });
    },
  );

  app.delete<{ Body: { token: string } }>('/api/notifications/device-tokens', async (request, reply) => {
    await notificationService.unregisterDeviceToken(request.body.token);
    return reply.status(204).send();
  });

  // --- Upload de justificatifs ---

  if (deps.uploadsDir) {
    const uploadsDir = deps.uploadsDir;
    fs.mkdirSync(uploadsDir, { recursive: true });
    app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

    const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.pdf']);
    app.post('/api/uploads/receipts', async (request, reply) => {
      const file = await request.file();
      if (!file) {
        return reply.status(400).send({ error: 'Aucun fichier reçu.' });
      }
      const extension = path.extname(file.filename).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        return reply.status(400).send({ error: 'Format accepté : image (png, jpg, webp) ou PDF.' });
      }
      const name = `${crypto.randomUUID()}${extension}`;
      await fs.promises.writeFile(path.join(uploadsDir, name), await file.toBuffer());
      return reply.status(201).send({ path: `/uploads/${name}` });
    });

    app.register(fastifyStatic, {
      root: uploadsDir,
      prefix: '/uploads/',
      decorateReply: false,
    });
  }

  // --- Front statique (production) ---

  if (deps.webDistDir && fs.existsSync(deps.webDistDir)) {
    app.register(fastifyStatic, {
      root: deps.webDistDir,
      prefix: '/',
    });
    // SPA fallback : toute route non-API sert index.html.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/uploads/')) {
        return reply.status(404).send({ error: 'Ressource introuvable.' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
