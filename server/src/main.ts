import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './infrastructure/persistence/sqlite/database.js';
import {
  SqliteEquipmentRepository,
  SqliteExpenseRepository,
  SqliteMemberRepository,
  SqliteReimbursementRepository,
  SqliteReservationRepository,
  SqliteUsageRecordRepository,
} from './infrastructure/persistence/sqlite/repositories.js';
import { SystemClock, UuidGenerator } from './infrastructure/tech/adapters.js';
import { buildApp } from './infrastructure/http/app.js';

/** Composition root : câblage des adapters sur les ports. */

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.resolve(here, '../../data');
const databasePath = process.env.DATABASE_PATH ?? path.join(dataDir, 'sharemate.sqlite');
const uploadsDir = process.env.UPLOADS_DIR ?? path.join(dataDir, 'uploads');
const webDistDir = process.env.WEB_DIST_DIR ?? path.resolve(here, '../../web/dist');
const port = Number(process.env.PORT ?? 3000);

const db = openDatabase(databasePath);

const app = buildApp({
  members: new SqliteMemberRepository(db),
  equipments: new SqliteEquipmentRepository(db),
  reservations: new SqliteReservationRepository(db),
  usageRecords: new SqliteUsageRecordRepository(db),
  expenses: new SqliteExpenseRepository(db),
  reimbursements: new SqliteReimbursementRepository(db),
  idGenerator: new UuidGenerator(),
  clock: new SystemClock(),
  uploadsDir,
  webDistDir,
});

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => {
    console.log(`ShareMate démarré sur le port ${port} (base : ${databasePath})`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
