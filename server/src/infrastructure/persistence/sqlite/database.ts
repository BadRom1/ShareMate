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
  déclarerFonctions(db);
  migrate(db);
  return db;
}

/**
 * `lower()` de SQLite ne replie que l'ASCII : « JOSÉ » y resterait distinct de « josé ».
 * La comparaison d'identifiant à la connexion doit garder la sémantique de `String.toLowerCase`,
 * sinon un membre au nom accentué ne pourrait plus se connecter qu'à la casse exacte.
 */
function déclarerFonctions(db: SqliteDb): void {
  db.function('minuscule', { deterministic: true }, (valeur: unknown) =>
    typeof valeur === 'string' ? valeur.toLowerCase() : null,
  );
}

/**
 * Une étape de schéma, appliquée une seule fois puis figée : son numéro de version est son rang
 * dans `MIGRATIONS`. Chaque `apply` doit rester idempotent — les bases antérieures au
 * versionnement partent de `user_version = 0` et rejouent donc la liste entière.
 */
interface Migration {
  readonly description: string;
  apply(db: SqliteDb): void;
}

const MIGRATIONS: Migration[] = [
  {
    // Schéma de référence au moment de l'introduction du versionnement : toute base en production
    // le possède déjà, d'où le `IF NOT EXISTS` partout. Les évolutions ultérieures s'ajoutent à la
    // suite, jamais ici.
    description: 'schéma de référence',
    apply(db) {
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
        -- Chaque lecture d'un justificatif remonte à la dépense qui le porte, par ce chemin.
        CREATE INDEX IF NOT EXISTS idx_expenses_receipt ON expenses(receipt_path);

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
    },
  },
  {
    // Réponses à un message précis (sous-fils). L'index vient après l'ALTER : sur une base
    // antérieure, la colonne n'existe qu'une fois celui-ci passé.
    description: 'messages.parent_id',
    apply(db) {
      if (!colonnes(db, 'messages').includes('parent_id')) {
        db.exec(`ALTER TABLE messages ADD COLUMN parent_id TEXT REFERENCES messages(id) ON DELETE CASCADE;`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);`);
    },
  },
  {
    // Annuaire cadré sur le périmètre du demandeur : on garde qui a invité qui, pour qu'un invitant
    // voie son invité (et puisse lui repartager son lien) avant qu'un équipement ne les réunisse.
    description: 'members.invited_by',
    apply(db) {
      if (!colonnes(db, 'members').includes('invited_by')) {
        db.exec(`ALTER TABLE members ADD COLUMN invited_by TEXT REFERENCES members(id);`);
      }
    },
  },
  {
    // Expiration des codes d'invitation (7 jours) : ils circulent hors bande et restaient valables
    // indéfiniment.
    description: 'échéance des invitations et révocation des codes de reprise de compte',
    apply(db) {
      if (!colonnes(db, 'member_credentials').includes('invite_expires_at')) {
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
    },
  },
  {
    // La clé primaire (equipment_id, member_id) ne sert pas la question inverse — « les équipements
    // de ce membre » — qui cadre désormais toutes les vues d'un membre.
    description: 'index equipment_members(member_id)',
    apply(db) {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_equipment_members_member ON equipment_members(member_id);`);
    },
  },
];

/** Version de schéma attendue par ce code : rang de la dernière migration connue. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Applique les migrations manquantes, une transaction par étape : la version n'avance que si
 * l'étape a réussi entièrement. `PRAGMA user_version` est le seul état de référence — une base
 * antérieure au versionnement vaut 0 et rejoue la liste, dont chaque étape est sans effet sur ce
 * qui existe déjà.
 */
function migrate(db: SqliteDb): void {
  refuserSchémaIncompatible(db);
  const appliquées = Number(db.pragma('user_version', { simple: true }));
  for (let rang = appliquées; rang < MIGRATIONS.length; rang += 1) {
    const migration = MIGRATIONS[rang]!;
    const version = rang + 1;
    db.transaction(() => {
      migration.apply(db);
      // PRAGMA n'accepte pas de paramètre lié ; `version` est un entier issu de MIGRATIONS.
      db.pragma(`user_version = ${version}`);
    })();
  }
}

/**
 * Les versions antérieures supprimaient (`DROP TABLE`) les schémas devenus incompatibles au
 * démarrage, sans trace ni sauvegarde. Sur un volume portant des données réelles, c'est une perte
 * irréversible que personne n'a décidée : on refuse désormais de démarrer et on laisse l'opérateur
 * trancher.
 */
function refuserSchémaIncompatible(db: SqliteDb): void {
  const sauvegarde = 'Sauvegardez d’abord la base (sqlite3 base.sqlite ".backup sauvegarde.sqlite").';
  if (tableExiste(db, 'groups')) {
    throw new Error(
      `Schéma incompatible : la table « groups » relève du modèle « collectif », abandonné. ${sauvegarde} ` +
        'Supprimez ensuite manuellement les tables de ce modèle (groups, group_members, equipment_access…).',
    );
  }
  const messages = colonnes(db, 'messages');
  if (messages.length > 0 && !messages.includes('thread_id')) {
    throw new Error(
      `Schéma incompatible : la table « messages » relève du mur de messages plat, antérieur aux fils. ${sauvegarde} ` +
        'Supprimez ensuite manuellement la table « messages ».',
    );
  }
}

function tableExiste(db: SqliteDb, nom: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(nom) !== undefined;
}

function colonnes(db: SqliteDb, table: string): string[] {
  // `PRAGMA table_info` d'une table absente renvoie une liste vide, sans lever.
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}
