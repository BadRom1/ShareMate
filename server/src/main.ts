import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './infrastructure/persistence/sqlite/database.js';
import {
  SqliteCredentialRepository,
  SqliteDeviceTokenRepository,
  SqliteEquipmentRepository,
  SqliteExpenseRepository,
  SqliteMemberRepository,
  SqliteMessageRepository,
  SqliteNotificationPreferenceRepository,
  SqliteNotificationRepository,
  SqlitePushSubscriptionRepository,
  SqliteReimbursementRepository,
  SqliteReservationRepository,
  SqliteSessionRepository,
  SqliteUsageRecordRepository,
} from './infrastructure/persistence/sqlite/repositories.js';
import {
  CryptoTokenGenerator,
  ScryptPasswordHasher,
  SystemClock,
  UuidGenerator,
} from './infrastructure/tech/adapters.js';
import { createPushSenderFromEnv } from './infrastructure/tech/push-sender.js';
import { buildApp } from './infrastructure/http/app.js';

/** Composition root : câblage des adapters sur les ports. */

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.resolve(here, '../../data');
const databasePath = process.env.DATABASE_PATH ?? path.join(dataDir, 'sharemate.sqlite');
const uploadsDir = process.env.UPLOADS_DIR ?? path.join(dataDir, 'uploads');
const webDistDir = process.env.WEB_DIST_DIR ?? path.resolve(here, '../../web/dist');
const port = Number(process.env.PORT ?? 3000);
const isProduction = process.env.NODE_ENV === 'production';
// Origines cross-origin de l'app native (ex. "https://localhost,capacitor://localhost").
const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const db = openDatabase(databasePath);

// Push (Web Push + FCM) : activé si les clés VAPID et/ou le compte de service FCM sont fournis.
const pushSender = createPushSenderFromEnv(process.env);

const app = await buildApp({
  members: new SqliteMemberRepository(db),
  equipments: new SqliteEquipmentRepository(db),
  reservations: new SqliteReservationRepository(db),
  usageRecords: new SqliteUsageRecordRepository(db),
  expenses: new SqliteExpenseRepository(db),
  reimbursements: new SqliteReimbursementRepository(db),
  messages: new SqliteMessageRepository(db),
  notifications: new SqliteNotificationRepository(db),
  notificationPreferences: new SqliteNotificationPreferenceRepository(db),
  pushSubscriptions: new SqlitePushSubscriptionRepository(db),
  deviceTokens: new SqliteDeviceTokenRepository(db),
  credentials: new SqliteCredentialRepository(db),
  sessions: new SqliteSessionRepository(db),
  passwordHasher: new ScryptPasswordHasher(),
  tokenGenerator: new CryptoTokenGenerator(),
  idGenerator: new UuidGenerator(),
  clock: new SystemClock(),
  cookieSecure: isProduction,
  // Le token de session ne doit jamais apparaître dans les logs.
  logger: { level: isProduction ? 'info' : 'debug', redact: ['req.headers.cookie', 'req.headers["set-cookie"]'] },
  trustProxy: isProduction,
  uploadsDir,
  webDistDir,
  corsOrigins,
  pushSender: pushSender ?? undefined,
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? null,
});

if (!pushSender) {
  app.log.info('Push désactivé (VAPID_* / FCM_SERVICE_ACCOUNT absents) : seul le centre in-app est actif.');
}

// Arrêt propre (Railway envoie SIGTERM à chaque redéploiement).
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    app.log.info(`Signal ${signal} reçu, arrêt en cours…`);
    await app.close();
    db.close();
    process.exit(0);
  });
}

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => {
    app.log.info(`ShareMate démarré sur le port ${port} (base : ${databasePath})`);
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
