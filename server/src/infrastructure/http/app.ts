import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../domain/shared/domain-error.js';
import type { Member } from '../../domain/member/member.js';
import { MemberService } from '../../application/member-service.js';
import { AuthService } from '../../application/auth-service.js';
import { EquipmentService } from '../../application/equipment-service.js';
import { ReservationService } from '../../application/reservation-service.js';
import { UsageService } from '../../application/usage-service.js';
import { ExpenseService } from '../../application/expense-service.js';
import { DiscussionService } from '../../application/discussion-service.js';
import { ChecklistService } from '../../application/checklist-service.js';
import { NotificationService } from '../../application/notification-service.js';
import type {
  ChecklistItemRepository,
  ChecklistRepository,
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
import { CLIENT_HEADER, sessionToken } from './session.js';
import { authRoutes } from './plugins/auth.js';
import { memberRoutes } from './plugins/members.js';
import { equipmentRoutes } from './plugins/equipments.js';
import { reservationRoutes } from './plugins/reservations.js';
import { usageRoutes } from './plugins/usage.js';
import { expenseRoutes } from './plugins/expenses.js';
import { discussionRoutes } from './plugins/discussions.js';
import { checklistRoutes } from './plugins/checklists.js';
import { notificationRoutes } from './plugins/notifications.js';
import { uploadRoutes } from './plugins/uploads.js';

export interface AppDependencies {
  members: MemberRepository;
  equipments: EquipmentRepository;
  reservations: ReservationRepository;
  usageRecords: UsageRecordRepository;
  expenses: ExpenseRepository;
  reimbursements: ReimbursementRepository;
  threads: ThreadRepository;
  messages: MessageRepository;
  checklists: ChecklistRepository;
  checklistItems: ChecklistItemRepository;
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
    deps.equipments,
    deps.passwordHasher,
    deps.tokenGenerator,
    deps.idGenerator,
    deps.clock,
  );
  const memberService = new MemberService(deps.members, deps.equipments, deps.credentials, deps.idGenerator);
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
  const checklistService = new ChecklistService(
    deps.checklists,
    deps.checklistItems,
    deps.equipments,
    deps.idGenerator,
    deps.clock,
  );

  // Toute route /api/* ou /uploads/* exige une session, sauf celles marquées `config.public`.
  // Posé sur la racine : les plugins de domaine, enregistrés ensuite, en héritent.
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

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof UnauthorizedError) {
      return reply.status(401).send({ error: error.message });
    }
    // Accès refusé rendu en 404 : la réponse est identique à celle d'une ressource
    // inexistante (même code, même message), ce qui interdit d'énumérer les
    // ressources des autres cercles. La trace serveur, elle, dit la vérité.
    if (error instanceof ForbiddenError) {
      app.log.warn(
        { memberId: request.authMember?.id, method: request.method, url: request.url },
        'accès hors cercle refusé (masqué en 404)',
      );
      return reply.status(404).send({ error: error.message });
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

  // Composition : chaque plugin reçoit explicitement les services dont il a besoin.
  await app.register(authRoutes, { authService, cookieSecure: deps.cookieSecure ?? false });
  await app.register(memberRoutes, { authService, memberService });
  await app.register(equipmentRoutes, { equipmentService });
  await app.register(reservationRoutes, { reservationService });
  await app.register(usageRoutes, { usageService });
  await app.register(expenseRoutes, { expenseService });
  await app.register(discussionRoutes, { discussionService });
  await app.register(checklistRoutes, { checklistService });
  await app.register(notificationRoutes, { notificationService, vapidPublicKey: deps.vapidPublicKey ?? null });
  if (deps.uploadsDir) {
    await app.register(uploadRoutes, { uploadsDir: deps.uploadsDir });
  }

  // --- Front statique (production) ---
  // Reste ici : le repli SPA s'appuie sur `reply.sendFile`, décoré par ce @fastify/static
  // sur la racine — un plugin encapsulé ne l'exposerait pas au gestionnaire 404.
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
