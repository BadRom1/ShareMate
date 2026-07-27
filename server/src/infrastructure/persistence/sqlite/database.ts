import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type SqliteDb = Database.Database;

/** Ouvre (et migre) la base SQLite. `:memory:` pour les tests. */
export function openDatabase(filePath: string): SqliteDb {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: SqliteDb): void {
  // Ancien modèle centré « collectif » : schéma incompatible, on repart de zéro.
  const hasLegacyGroups = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'groups'`).get();
  if (hasLegacyGroups) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      DROP TABLE IF EXISTS reimbursements;
      DROP TABLE IF EXISTS expenses;
      DROP TABLE IF EXISTS usage_records;
      DROP TABLE IF EXISTS reservations;
      DROP TABLE IF EXISTS equipment_access;
      DROP TABLE IF EXISTS equipments;
      DROP TABLE IF EXISTS group_members;
      DROP TABLE IF EXISTS "groups";
      DROP TABLE IF EXISTS members;
    `);
    db.pragma('foreign_keys = ON');
  }

  // Le forum est passé d'un mur de messages plat (messages.equipment_id) à des fils
  // (threads + messages.thread_id). L'ancien schéma est incompatible : on repart de zéro.
  const messageColumns = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
  if (messageColumns.length > 0 && !messageColumns.some((c) => c.name === 'thread_id')) {
    db.exec('DROP TABLE IF EXISTS messages;');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      invited_by TEXT REFERENCES members(id)
    );

    CREATE TABLE IF NOT EXISTS equipments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      acquisition_date TEXT NOT NULL,
      purchase_value_cents INTEGER NOT NULL,
      meter_unit TEXT NOT NULL CHECK (meter_unit IN ('HOURS', 'KILOMETERS')),
      maintenance_threshold REAL
    );

    CREATE TABLE IF NOT EXISTS equipment_members (
      equipment_id TEXT NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id),
      position INTEGER NOT NULL,
      PRIMARY KEY (equipment_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      equipment_id TEXT NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id),
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'REQUIRED' CHECK (status IN ('PLANNED', 'REQUIRED')),
      created_at TEXT NOT NULL DEFAULT '',
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reservations_equipment ON reservations(equipment_id);

    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      equipment_id TEXT NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id),
      recorded_at TEXT NOT NULL,
      meter_reading REAL NOT NULL,
      fuel_added_liters REAL,
      notes TEXT,
      is_maintenance INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_usage_equipment ON usage_records(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_usage_member ON usage_records(member_id);

    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      equipment_id TEXT NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      payer_id TEXT NOT NULL REFERENCES members(id),
      date TEXT NOT NULL,
      category TEXT NOT NULL,
      split_json TEXT NOT NULL,
      receipt_path TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_equipment ON expenses(equipment_id);

    CREATE TABLE IF NOT EXISTS reimbursements (
      id TEXT PRIMARY KEY,
      equipment_id TEXT NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
      from_member_id TEXT NOT NULL REFERENCES members(id),
      to_member_id TEXT NOT NULL REFERENCES members(id),
      amount_cents INTEGER NOT NULL,
      date TEXT NOT NULL,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reimbursements_equipment ON reimbursements(equipment_id);

    CREATE TABLE IF NOT EXISTS member_credentials (
      member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
      password_hash TEXT,
      invite_code TEXT UNIQUE,
      invite_expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      equipment_id TEXT NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES members(id),
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_threads_equipment ON threads(equipment_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES members(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at TEXT,
      parent_id TEXT REFERENCES messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

    CREATE TABLE IF NOT EXISTS checklists (
      id TEXT PRIMARY KEY,
      equipment_id TEXT NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES members(id),
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_checklists_equipment ON checklists(equipment_id);

    CREATE TABLE IF NOT EXISTS checklist_items (
      id TEXT PRIMARY KEY,
      checklist_id TEXT NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      position INTEGER NOT NULL,
      checked_at TEXT,
      checked_by_id TEXT REFERENCES members(id)
    );
    CREATE INDEX IF NOT EXISTS idx_checklist_items_checklist ON checklist_items(checklist_id);

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      recipient_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      link TEXT,
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id);

    CREATE TABLE IF NOT EXISTS notification_preferences (
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      in_app INTEGER NOT NULL DEFAULT 1,
      push INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (member_id, type)
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_member ON push_subscriptions(member_id);

    CREATE TABLE IF NOT EXISTS device_tokens (
      token TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      platform TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_device_tokens_member ON device_tokens(member_id);
  `);

  // Réponses à un message précis (sous-fils) : ajoute parent_id aux bases antérieures.
  // Doit précéder la création de l'index parent_id ci-dessous : sur une base existante, le
  // CREATE TABLE IF NOT EXISTS est ignoré et la colonne n'apparaît que via cet ALTER.
  const currentMessageColumns = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
  if (!currentMessageColumns.some((c) => c.name === 'parent_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN parent_id TEXT REFERENCES messages(id) ON DELETE CASCADE;`);
  }
  // parent_id est désormais garanti présent (base neuve ou migrée) : l'index peut être créé.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);`);

  // Annuaire cadré sur le périmètre du demandeur : on garde qui a invité qui, pour qu'un invitant
  // voie son invité (et puisse lui repartager son lien) avant qu'un équipement ne les réunisse.
  const memberColumns = db.prepare(`PRAGMA table_info(members)`).all() as { name: string }[];
  if (!memberColumns.some((c) => c.name === 'invited_by')) {
    db.exec(`ALTER TABLE members ADD COLUMN invited_by TEXT REFERENCES members(id);`);
  }

  // Expiration des codes d'invitation (7 jours) : ils circulent hors bande et restaient valables
  // indéfiniment.
  const credentialColumns = db.prepare(`PRAGMA table_info(member_credentials)`).all() as { name: string }[];
  if (!credentialColumns.some((c) => c.name === 'invite_expires_at')) {
    db.exec(`ALTER TABLE member_credentials ADD COLUMN invite_expires_at TEXT;`);
  }
  // Un code posé au-dessus d'un mot de passe existant est un vestige de la version où une
  // invitation réécrivait le mot de passe (prise de contrôle de compte) : il est révoqué.
  // Les invitations légitimes en cours (compte jamais ouvert) reçoivent l'échéance manquante.
  db.exec(`
    UPDATE member_credentials SET invite_code = NULL, invite_expires_at = NULL
      WHERE invite_code IS NOT NULL AND password_hash IS NOT NULL;
    UPDATE member_credentials SET invite_expires_at = strftime('%Y-%m-%dT%H:%M:%S.000Z', 'now', '+7 days')
      WHERE invite_code IS NOT NULL AND invite_expires_at IS NULL;
  `);
}
