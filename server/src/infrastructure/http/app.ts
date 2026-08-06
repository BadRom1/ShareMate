import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest, FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
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
import { SubEquipmentService } from '../../application/sub-equipment-service.js';
import { ReservationService } from '../../application/reservation-service.js';
import { UsageService } from '../../application/usage-service.js';
import { ExpenseService } from '../../application/expense-service.js';
import { DiscussionService } from '../../application/discussion-service.js';
import { ChecklistService } from '../../application/checklist-service.js';
import { DocumentService } from '../../application/document-service.js';
import { NotificationService } from '../../application/notification-service.js';
import type {
  AuditLogger,
  ChecklistItemRepository,
  ChecklistRepository,
  Clock,
  CredentialRepository,
  DeviceTokenRepository,
  DocumentRepository,
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
  SubEquipmentRepository,
  TokenGenerator,
  UsageRecordRepository,
} from '../../application/ports.js';
import { CLIENT_HEADER, SESSION_COOKIE, sessionToken, setSessionCookie } from './session.js';
import { AJV_OPTIONS, schemaErrorFormatter } from './schema.js';
import { DEFAULT_RATE_LIMITS, RATE_WINDOW, keyPerRoute, tooManyRequests } from './rate-limit.js';
import type { RateLimits } from './rate-limit.js';
import { authRoutes } from './plugins/auth.js';
import { memberRoutes } from './plugins/members.js';
import { equipmentRoutes } from './plugins/equipments.js';
import { subEquipmentRoutes } from './plugins/sub-equipments.js';
import { reservationRoutes } from './plugins/reservations.js';
import { usageRoutes } from './plugins/usage.js';
import { expenseRoutes } from './plugins/expenses.js';
import { discussionRoutes } from './plugins/discussions.js';
import { checklistRoutes } from './plugins/checklists.js';
import { documentRoutes } from './plugins/documents.js';
import { notificationRoutes } from './plugins/notifications.js';
import { uploadRoutes } from './plugins/uploads.js';
import { createS3ObjectStore } from '../tech/object-store.js';
import { createReceiptStorage } from '../tech/receipt-storage.js';
import type { ReceiptStorage } from '../tech/receipt-storage.js';
import { createDocumentStorage } from '../tech/document-storage.js';
import type { DocumentStorage } from '../tech/document-storage.js';
import { createAttachmentStorage } from '../tech/attachment-storage.js';
import type { AttachmentStorage } from '../tech/attachment-storage.js';
import { MAX_DOCUMENT_SIZE_BYTES } from '../../domain/document/document.js';

export interface AppDependencies {
  members: MemberRepository;
  equipments: EquipmentRepository;
  subEquipments: SubEquipmentRepository;
  reservations: ReservationRepository;
  usageRecords: UsageRecordRepository;
  expenses: ExpenseRepository;
  reimbursements: ReimbursementRepository;
  threads: ThreadRepository;
  messages: MessageRepository;
  checklists: ChecklistRepository;
  checklistItems: ChecklistItemRepository;
  documents: DocumentRepository;
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
  /**
   * Répertoire des justificatifs (null = upload désactivé). Quand un bucket est configuré, il ne
   * sert plus qu'à relire les justificatifs déposés avant la bascule.
   */
  uploadsDir?: string | null;
  /**
   * Répertoire de repli des documents, quand aucun bucket n'est configuré (null = seuls les liens
   * sont gérés). Le bucket S3/R2, lui, est lu dans `objectStorageEnv`.
   */
  documentsDir?: string | null;
  /** Répertoire de repli des pièces jointes (null = les messages n'en acceptent pas). */
  attachmentsDir?: string | null;
  /** Environnement où lire la configuration du bucket S3/R2 (`process.env` en production). */
  objectStorageEnv?: NodeJS.ProcessEnv;
  /**
   * Stockages déjà construits, qui l'emportent sur ce que l'environnement décrirait. Les tests
   * d'intégration s'en servent pour jouer un bucket — dont la lecture est une redirection signée
   * — sans réseau ; en production, ils sont toujours déduits des variables et des répertoires.
   */
  receiptStorage?: ReceiptStorage;
  documentStorage?: DocumentStorage;
  attachmentStorage?: AttachmentStorage;
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

/**
 * Refus émis par `@fastify/multipart` pendant la lecture du flux, rendus en français. Seuls ceux
 * qu'une requête légitime peut provoquer : les autres (violation de prototype, type de contenu
 * inattendu) relèvent d'un client mal formé, et le message générique leur suffit.
 */
const MULTIPART_ERRORS: Record<string, string> = {
  FST_FILES_LIMIT: 'Un seul fichier par envoi.',
  FST_PARTS_LIMIT: 'Trop d’éléments dans le formulaire.',
  FST_FIELDS_LIMIT: 'Trop de champs dans le formulaire.',
};

/**
 * Refus de poids, au plafond de la route visée : un justificatif (10 Mo) et un document du dossier
 * (25 Mo) n'acceptent pas le même fichier. Annoncer un plafond unique renvoyait le membre à un
 * chiffre qui n'était pas le sien — « 25 Mo maximum » pour un reçu refusé à 12.
 */
function fileTooLargeMessage(request: FastifyRequest): string {
  const maxBytes = request.routeOptions?.config?.maxFileBytes ?? MAX_DOCUMENT_SIZE_BYTES;
  return `Fichier trop lourd (${maxBytes / (1024 * 1024)} Mo maximum).`;
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

  /**
   * Plafond du trafic rejeté faute de session. Le compteur du greffon est attaché au niveau de la
   * route, donc **après** les hooks de contexte : la garde de session ci-dessous rendait 401 avant
   * qu'il ne s'incrémente, et marteler une route protégée sans cookie valable n'était borné par
   * rien. Ce compteur-ci est consommé sur ce seul chemin d'échec — le trafic authentifié garde
   * donc intact le plafond de sa route, sans double comptage.
   */
  const rejectedTrafficLimit = app.createRateLimit({
    max: rateLimits.global,
    timeWindow: RATE_WINDOW,
    keyGenerator: keyPerRoute,
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
  // Justificatifs, documents et pièces jointes partagent le même bucket S3/R2 dès que son
  // environnement est complet, et retombent chacun sur leur répertoire sinon. Sans ni l'un ni
  // l'autre, il n'y a ni fichier à servir ni fichier à purger, et le dossier n'accepte que des
  // liens. Le client S3 est construit une fois pour les trois : ils visent le même bucket, et
  // chaque client traîne son propre pool de connexions.
  const bucket = createS3ObjectStore(deps.objectStorageEnv ?? {});
  const receiptStorage = deps.receiptStorage ?? createReceiptStorage(bucket, deps.uploadsDir ?? null) ?? undefined;
  const documentStorage = deps.documentStorage ?? createDocumentStorage(bucket, deps.documentsDir ?? null);
  const attachmentStorage = deps.attachmentStorage ?? createAttachmentStorage(bucket, deps.attachmentsDir ?? null);
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
    deps.documents,
    documentStorage ?? undefined,
    deps.messages,
    attachmentStorage ?? undefined,
  );
  const subEquipmentService = new SubEquipmentService(deps.subEquipments, deps.equipments, deps.idGenerator);
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
    deps.documents,
    deps.idGenerator,
    deps.clock,
    notificationService,
    attachmentStorage ?? undefined,
  );
  const checklistService = new ChecklistService(
    deps.checklists,
    deps.checklistItems,
    deps.equipments,
    deps.idGenerator,
    deps.clock,
  );
  const documentService = new DocumentService(
    deps.documents,
    deps.equipments,
    deps.messages,
    deps.idGenerator,
    deps.clock,
    documentStorage ?? undefined,
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
    // Corps multipart hors limites : @fastify/multipart échoue pendant la lecture du flux, donc
    // avant tout code applicatif, et ses messages sont en anglais. Le membre, lui, a simplement
    // choisi un fichier trop lourd.
    if (httpError.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send({ error: fileTooLargeMessage(request) });
    }
    const multipartMessage = MULTIPART_ERRORS[httpError.code ?? ''];
    if (multipartMessage) {
      return reply.status(413).send({ error: multipartMessage });
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
    // Transverse : deux domaines téléversent (justificatifs, documents) et le greffon ne peut être
    // enregistré qu'une fois par contexte. Le plafond global est celui du plus gros dépôt accepté ;
    // chaque route resserre le sien à la lecture du corps.
    await protectedScope.register(multipart, { limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES } });

    protectedScope.addHook('onRequest', async (request, reply) => {
      if (request.routeOptions?.config?.public) {
        return;
      }
      const token = sessionToken(request);
      const session = await authService.authenticate(token);
      if (!session) {
        // Le plafond de la route ne sera jamais atteint sur ce chemin : on consomme donc ici
        // celui du trafic rejeté, sans quoi le refus lui-même serait gratuit et répétable.
        const verdict = await rejectedTrafficLimit(request);
        // `isAllowed` marque une IP en liste blanche : aucun compteur, donc rien à dépasser.
        if (!verdict.isAllowed && verdict.isExceeded) {
          const { message, statusCode } = tooManyRequests(request, { ttl: verdict.ttl, statusCode: 429 });
          return reply.status(statusCode).send({ error: message });
        }
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
    await protectedScope.register(subEquipmentRoutes, { subEquipmentService });
    await protectedScope.register(reservationRoutes, { reservationService });
    await protectedScope.register(usageRoutes, { usageService });
    await protectedScope.register(expenseRoutes, { expenseService });
    await protectedScope.register(discussionRoutes, {
      discussionService,
      storage: attachmentStorage ?? undefined,
      rateLimits,
    });
    await protectedScope.register(checklistRoutes, { checklistService });
    await protectedScope.register(documentRoutes, {
      documentService,
      storage: documentStorage ?? undefined,
      rateLimits,
    });
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
