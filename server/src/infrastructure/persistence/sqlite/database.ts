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

  db.exec(`
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT
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
      invite_code TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      equipment_id TEXT NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES members(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_equipment ON messages(equipment_id);

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
}
