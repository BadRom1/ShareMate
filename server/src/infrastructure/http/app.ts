import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import {
  AuthorizationError,
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
  AuditLogger,
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
import { CLIENT_HEADER, SESSION_COOKIE, sessionToken, setSessionCookie } from './session.js';
import { AJV_OPTIONS, schemaErrorFormatter } from './schema.js';
import { DEFAULT_RATE_LIMITS, RATE_WINDOW, tooManyRequests } from './rate-limit.js';
import type { RateLimits } from './rate-limit.js';
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
import { FileSystemReceiptStorage } from '../tech/receipt-storage.js';

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
  /** Plafonds de requêtes par IP (voir DEFAULT_RATE_LIMITS) : relevés dans les tests d'intégration. */
  rateLimits?: Partial<RateLimits>;
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: deps.trustProxy ?? false,
    ajv: { customOptions: AJV_OPTIONS },
    schemaErrorFormatter,
  });

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
  // Global : chaque route est plafonnée par défaut, les plus exposées le sont plus bas
  // via `config.rateLimit` (voir rate-limit.ts).
  const rateLimits = { ...DEFAULT_RATE_LIMITS, ...deps.rateLimits };
  await app.register(rateLimit, {
    max: rateLimits.global,
    timeWindow: RATE_WINDOW,
    errorResponseBuilder: tooManyRequests,
  });

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
  const memberService = new MemberService(deps.members, deps.equipments, deps.credentials);
  // Sans répertoire d'upload, il n'y a ni justificatif à servir ni fichier à purger.
  const receiptStorage = deps.uploadsDir ? new FileSystemReceiptStorage(deps.uploadsDir) : undefined;
  // Le journal des gestes sensibles part dans les logs du serveur : hors de portée des membres
  // concernés, contrairement aux notifications qu'ils peuvent effacer.
  const auditLogger: AuditLogger = {
    record: (entry) => app.log.info(entry, 'geste sensible'),
  };
  const equipmentService = new EquipmentService(
    deps.equipments,
    deps.members,
    deps.idGenerator,
    deps.expenses,
    notificationService,
    auditLogger,
    receiptStorage,
  );
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
    receiptStorage,
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

  app.decorateRequest('authMember', null as unknown as Member);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof UnauthorizedError) {
      return reply.status(401).send({ error: error.message });
    }
    // 403 et non 401 : la session est valide, seul le geste est refusé. Un 401 ferait
    // retomber le client sur l'écran de connexion (web/src/api.ts) pour un simple refus.
    if (error instanceof AuthorizationError) {
      return reply.status(403).send({ error: error.message });
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
    const httpError = error as { validation?: unknown; statusCode?: number; message?: string; code?: string };
    // Corps illisible : Fastify échoue avant tout schéma, avec son message en anglais.
    if (httpError.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || httpError.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return reply.status(400).send({ error: 'Corps de requête invalide : JSON illisible.' });
    }
    if (httpError.validation || (httpError.statusCode && httpError.statusCode < 500)) {
      return reply.status(httpError.statusCode ?? 400).send({ error: httpError.message ?? 'Requête invalide.' });
    }
    app.log.error(error);
    return reply.status(500).send({ error: 'Erreur interne du serveur.' });
  });

  app.get('/api/health', { config: { public: true } }, async () => ({ status: 'ok' }));

  /**
   * Périmètre protégé. Le hook de session est posé sur ce contexte encapsulé, et les plugins de
   * domaine sont enregistrés dedans : toute route qu'ils déclarent exige une session, sauf celles
   * marquées `config.public`. C'est la composition qui porte le périmètre, pas un préfixe d'URL —
   * `request.raw.url` n'est pas décodé alors que le routeur, lui, l'est, si bien qu'un test sur
   * `startsWith('/api/')` laissait `/%61pi/uploads/receipts` atteindre le handler sans session.
   * Les routes hors de ce contexte (front statique, santé) sont publiques par construction.
   */
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', async (request, reply) => {
      if (request.routeOptions?.config?.public) {
        return;
      }
      const token = sessionToken(request);
      const session = await authService.authenticate(token);
      if (!session) {
        return reply.status(401).send({ error: 'Authentification requise.' });
      }
      // Prolongation glissante rendue au navigateur : sans cette repose, le cookie garderait
      // l'échéance de la connexion et disparaîtrait pendant que la session serveur court encore.
      // L'app native, elle, porte son jeton en Bearer et n'a pas de cookie à rafraîchir.
      if (session.renewed && request.cookies[SESSION_COOKIE]) {
        setSessionCookie(reply, token!, session.expiresAt, deps.cookieSecure ?? false);
      }
      request.authMember = session.member;
    });

    // Composition : chaque plugin reçoit explicitement les services dont il a besoin.
    await protectedScope.register(authRoutes, { authService, cookieSecure: deps.cookieSecure ?? false, rateLimits });
    await protectedScope.register(memberRoutes, { authService, memberService, rateLimits });
    await protectedScope.register(equipmentRoutes, { equipmentService });
    await protectedScope.register(reservationRoutes, { reservationService });
    await protectedScope.register(usageRoutes, { usageService });
    await protectedScope.register(expenseRoutes, { expenseService });
    await protectedScope.register(discussionRoutes, { discussionService });
    await protectedScope.register(checklistRoutes, { checklistService });
    await protectedScope.register(notificationRoutes, {
      notificationService,
      vapidPublicKey: deps.vapidPublicKey ?? null,
    });
    if (receiptStorage) {
      await protectedScope.register(uploadRoutes, { storage: receiptStorage, expenseService, rateLimits });
    }
  });

  // --- Front statique (production) ---
  // Reste ici : le repli SPA s'appuie sur `reply.sendFile`, décoré par ce @fastify/static
  // sur la racine — un plugin encapsulé ne l'exposerait pas au gestionnaire 404.
  if (deps.webDistDir && fs.existsSync(deps.webDistDir)) {
    await app.register(fastifyStatic, {
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
