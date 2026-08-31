import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { isValidEmail } from '../../../domain/member/member.js';

export type SqliteDb = Database.Database;

/** Ouvre (et migre) la base SQLite. `:memory:` pour les tests. */
export function openDatabase(filePath: string): SqliteDb {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  declareFunctions(db);
  migrate(db);
  return db;
}

/**
 * `lower()` de SQLite ne replie que l'ASCII : « JOSÉ » y resterait distinct de « josé ».
 * La comparaison d'identifiant à la connexion doit garder la sémantique de `String.toLowerCase`,
 * sinon un membre au nom accentué ne pourrait plus se connecter qu'à la casse exacte.
 */
function declareFunctions(db: SqliteDb): void {
  db.function('minuscule', { deterministic: true }, (valeur: unknown) =>
    typeof valeur === 'string' ? valeur.toLowerCase() : null,
  );
}

/**
 * Une étape de schéma, appliquée une seule fois puis figée : son numéro de version est son rank
 * dans `MIGRATIONS`. Chaque `apply` doit rester idempotent — les bases antérieures au
 * versionnement partent de `user_version = 0` et rejouent donc la liste entière.
 */
interface Migration {
  readonly description: string;
  /**
   * Reconstruction de table : l'étape s'exécute clés étrangères désarmées (voir `migrate`).
   * Réservé aux étapes qui recréent une table référencée — elles doivent alors vérifier
   * elles-mêmes l'intégrité (`PRAGMA foreign_key_check`) avant de rendre la main.
   */
  readonly withoutForeignKeys?: boolean;
  apply(db: SqliteDb): void;
}

/** Rappel joint à tout refus de démarrage : rien ne doit être corrigé sans copie préalable. */
const BACKUP_FIRST = 'Sauvegardez d’abord la base (sqlite3 base.sqlite ".backup sauvegarde.sqlite").';

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
      if (!columns(db, 'messages').includes('parent_id')) {
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
      if (!columns(db, 'members').includes('invited_by')) {
        db.exec(`ALTER TABLE members ADD COLUMN invited_by TEXT REFERENCES members(id);`);
      }
    },
  },
  {
    // Expiration des codes d'invitation (7 jours) : ils circulent hors bande et restaient valables
    // indéfiniment.
    description: 'échéance des invitations et révocation des codes de reprise de compte',
    apply(db) {
      if (!columns(db, 'member_credentials').includes('invite_expires_at')) {
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
  {
    // `Member.create` valide désormais l'email, qui sert d'identifiant de connexion : sans cette
    // étape, une rangée antérieure mal formée rendrait son membre impossible à charger — et donc
    // l'application inutilisable pour tout son cercle. Le tri se fait ici, une fois, à froid.
    description: 'emails de membres normalisés, dédoublonnés',
    apply(db) {
      const rows = db.prepare('SELECT id, name, email FROM members WHERE email IS NOT NULL').all() as {
        id: string;
        name: string;
        email: string;
      }[];
      const forget = db.prepare('UPDATE members SET email = NULL WHERE id = ?');
      const normalize = db.prepare('UPDATE members SET email = ? WHERE id = ?');
      const seen = new Map<string, string>();
      const rejected: string[] = [];
      for (const row of rows) {
        const email = row.email.trim();
        // Un champ laissé vide par un formulaire n'est pas une perte : le domaine lit déjà
        // « vide » comme « absent ». Le passer à NULL ne fait qu'écrire ce qu'il signifie.
        if (email.length === 0) {
          forget.run(row.id);
          continue;
        }
        const owner = seen.get(email.toLowerCase());
        if (!isValidEmail(email)) {
          rejected.push(`${row.id} (${row.name}) « ${row.email} » : forme invalide`);
        } else if (owner) {
          rejected.push(`${row.id} (${row.name}) « ${row.email} » : déjà porté par ${owner}`);
        } else {
          seen.set(email.toLowerCase(), row.id);
          if (email !== row.email) {
            normalize.run(email, row.id);
          }
        }
      }
      // Effacer ces adresses en silence, comme le faisait la première version de cette étape,
      // c'est priver leur titulaire de son moyen de connexion sans qu'il sache pourquoi : la
      // perte a seulement changé de granularité, de la table à la colonne. Même posture que pour
      // un schéma incompatible — on refuse de démarrer, l'opérateur tranche, sauvegarde en main.
      if (rejected.length > 0) {
        throw new Error(
          `Emails de membres incompatibles : ces adresses servent d’identifiant de connexion et ne ` +
            `peuvent pas être conservées telles quelles. ${BACKUP_FIRST} Corrigez-les ensuite, ou effacez-les ` +
            `(UPDATE members SET email = NULL WHERE id = …) :\n  - ${rejected.join('\n  - ')}`,
        );
      }
    },
  },
  {
    // Dossier de documents par équipement : fichiers déposés dans le stockage d'objets et liens
    // externes, dans la même table. Les colonnes d'un fichier et celle d'un lien s'excluent — la
    // contrainte l'écrit ici plutôt que de s'en remettre au seul domaine, car une ligne qui
    // porterait les deux (ou aucune) serait impossible à charger, et rendrait le dossier illisible
    // pour tout le cercle.
    description: 'documents rattachés à un équipement',
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY,
          equipment_id TEXT NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
          author_id TEXT NOT NULL REFERENCES members(id),
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          created_at TEXT NOT NULL,
          storage_key TEXT,
          file_name TEXT,
          content_type TEXT,
          size_bytes INTEGER,
          url TEXT,
          CHECK (
            (storage_key IS NOT NULL AND file_name IS NOT NULL AND content_type IS NOT NULL
              AND size_bytes IS NOT NULL AND url IS NULL)
            OR (storage_key IS NULL AND file_name IS NULL AND content_type IS NULL
              AND size_bytes IS NULL AND url IS NOT NULL)
          )
        );
        CREATE INDEX IF NOT EXISTS idx_documents_equipment ON documents(equipment_id);
        -- La purge d'un objet remonte aux documents qui le nomment, par cette clé.
        CREATE INDEX IF NOT EXISTS idx_documents_storage_key ON documents(storage_key);
      `);
    },
  },
  {
    // Pièce jointe d'un message de discussion : au plus une par message, décrite par les quatre
    // colonnes d'un fichier stocké. Les quatre vont ensemble — une ligne n'en portant qu'une
    // partie serait impossible à charger —, d'où l'index partiel plutôt qu'une table à part :
    // une pièce jointe n'a pas d'existence propre, elle suit son message.
    description: 'pièce jointe des messages',
    apply(db) {
      const existantes = columns(db, 'messages');
      for (const [colonne, type] of [
        ['attachment_key', 'TEXT'],
        ['attachment_name', 'TEXT'],
        ['attachment_type', 'TEXT'],
        ['attachment_size', 'INTEGER'],
      ] as const) {
        if (!existantes.includes(colonne)) {
          db.exec(`ALTER TABLE messages ADD COLUMN ${colonne} ${type};`);
        }
      }
      // La purge d'un objet remonte au message qui le nomme, par cette clé.
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_messages_attachment ON messages(attachment_key)
           WHERE attachment_key IS NOT NULL;`,
      );
    },
  },
  {
    // Contenu du lot d'un équipement : remorque, godets, pompe à graisse… Ces éléments n'ont pas
    // d'existence propre — ils ne se réservent pas et ne portent pas de dépense —, d'où la cascade
    // sur l'équipement : le lot disparaît avec ce qu'il accompagnait.
    description: 'sous-équipements d’un équipement',
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sub_equipments (
          id TEXT PRIMARY KEY,
          equipment_id TEXT NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          quantity INTEGER NOT NULL DEFAULT 1,
          notes TEXT,
          position INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sub_equipments_equipment ON sub_equipments(equipment_id);
      `);
    },
  },
  {
    // L'app native Android est retirée : plus aucun client n'enregistre de jeton d'appareil, et
    // le serveur n'envoie plus que du Web Push. La table ne portait que ces jetons FCM.
    description: 'retrait des jetons d’appareil (app native)',
    apply(db) {
      db.exec(`
        DROP INDEX IF EXISTS idx_device_tokens_member;
        DROP TABLE IF EXISTS device_tokens;
      `);
    },
  },
  {
    // La catégorie et la valeur d'achat d'un équipement ne servent qu'à décrire sa fiche : rien
    // dans l'agenda, les relevés ou les soldes n'en dépend. Les exiger n'obtenait qu'une saisie
    // de complaisance avant de pouvoir partager un équipement, d'où leur passage en facultatif.
    //
    // SQLite ne sait pas retirer un NOT NULL : la table se reconstruit (renommer, recréer,
    // recopier, supprimer). Deux réglages rendent l'opération sûre, et sont tous les deux
    // nécessaires :
    // - clés étrangères désarmées (`withoutForeignKeys`), sans quoi le `DROP` final exécute un
    //   effacement implicite qui emporterait par cascade tout ce qui pend aux équipements —
    //   cercle, réservations, relevés, dépenses, remboursements ;
    // - `legacy_alter_table = ON`, sans quoi le renommage réécrit les clauses `REFERENCES` des
    //   tables filles pour les faire pointer vers `equipments_ancien`, qui n'existera plus.
    // L'intégrité est revérifiée avant de rendre la main, dans la transaction de l'étape.
    description: 'catégorie et valeur d’achat facultatives',
    withoutForeignKeys: true,
    apply(db) {
      const colonnes = ['category', 'purchase_value_cents'] as const;
      // Rien à relâcher : colonnes déjà facultatives (étape rejouée), ou table qui ne les porte
      // pas — une base de test réduite n'a pas à passer par une reconstruction.
      const présentes = columns(db, 'equipments');
      if (!colonnes.every((c) => présentes.includes(c)) || colonnes.every((c) => nullable(db, 'equipments', c))) {
        return;
      }
      db.pragma('legacy_alter_table = ON');
      try {
        db.exec(`
          ALTER TABLE equipments RENAME TO equipments_ancien;
          CREATE TABLE equipments (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            category TEXT,
            acquisition_date TEXT NOT NULL,
            purchase_value_cents INTEGER,
            meter_unit TEXT NOT NULL CHECK (meter_unit IN ('HOURS', 'KILOMETERS')),
            maintenance_threshold REAL
          );
          INSERT INTO equipments
              (id, name, category, acquisition_date, purchase_value_cents, meter_unit, maintenance_threshold)
            SELECT id, name, category, acquisition_date, purchase_value_cents, meter_unit, maintenance_threshold
              FROM equipments_ancien;
          DROP TABLE equipments_ancien;
        `);
      } finally {
        db.pragma('legacy_alter_table = OFF');
      }
      // Filet : une reconstruction qui aurait laissé une fille orpheline se voit ici, dans la
      // transaction de l'étape, donc avant que la version de schéma n'avance.
      const orphelines = db.pragma('foreign_key_check') as unknown[];
      if (orphelines.length > 0) {
        throw new Error(
          `Reconstruction de la table « equipments » incohérente : ${orphelines.length} ligne(s) orpheline(s). ${BACKUP_FIRST}`,
        );
      }
    },
  },
  {
    // Administrateur de l'instance, seul habilité à fusionner deux comptes en un. Sur une base
    // neuve, `AuthService.bootstrap` marque le compte qu'il crée.
    //
    // Sur une base existante, la colonne reste à 0 partout, et c'est voulu : aucun repère n'y
    // désigne le premier compte — `invited_by` vaut NULL sur tous les membres antérieurs à cette
    // colonne. Deviner ici, c'est donner à un inconnu le pouvoir d'absorber n'importe quel
    // compte. L'opérateur tranche, à froid, avec `npm run admin:designate` : tant qu'il ne l'a pas
    // fait, l'instance n'a pas d'administrateur et le geste n'est ouvert à personne.
    description: 'members.is_admin',
    apply(db) {
      if (!columns(db, 'members').includes('is_admin')) {
        db.exec(`ALTER TABLE members ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;`);
      }
    },
  },
  {
    // Réinitialisation d'un mot de passe perdu : un code à durée de vie courte, transmis hors
    // bande comme l'est déjà une invitation. Colonnes distinctes de celles de l'invitation, et
    // non un drapeau posé à côté d'un code unique : les deux gestes n'ouvrent pas la même chose
    // — l'invitation, un compte jamais ouvert ; la réinitialisation, un compte en service —, et
    // c'est précisément leur confusion qui rendrait un code d'invitation capable de reprendre un
    // compte (voir `MemberCredential`).
    //
    // L'unicité passe par un index : SQLite ne sait pas ajouter une colonne UNIQUE à une table
    // existante, et un index unique laisse de toute façon coexister autant de NULL que de comptes
    // sans réinitialisation en cours.
    description: 'codes de réinitialisation de mot de passe',
    apply(db) {
      const existantes = columns(db, 'member_credentials');
      for (const [colonne, type] of [
        ['reset_code', 'TEXT'],
        ['reset_expires_at', 'TEXT'],
      ] as const) {
        if (!existantes.includes(colonne)) {
          db.exec(`ALTER TABLE member_credentials ADD COLUMN ${colonne} ${type};`);
        }
      }
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_member_credentials_reset ON member_credentials(reset_code)
           WHERE reset_code IS NOT NULL;`,
      );
    },
  },
  {
    // Deux manques d'un même trou : celui qui oublie sa saisie faisait porter ses heures au
    // suivant, sans que personne ne puisse ni le voir ni le corriger.
    // - `start_reading` : le relevé porte son propre point de départ, au lieu de le déduire du
    //   relevé précédent. Un écart entre les deux devient visible, et attribuable.
    // - `member_id` facultatif : le segment constaté par un membre mais dû à un autre existe
    //   comme relevé à part entière, en attente d'attribution, plutôt que d'être fondu dans
    //   celui qui le découvre.
    // La reprise donne à chaque relevé antérieur le compteur qui le précède dans la chaîne de
    // son équipement : exactement ce que le calcul des durées déduisait jusqu'ici, écrit une
    // fois pour toutes. Le premier relevé de chaque équipement garde NULL — son compteur
    // d'origine reste inconnu, et sa durée avec.
    description: 'compteur de départ et relevés en attente d’attribution',
    apply(db) {
      const présentes = columns(db, 'usage_records');
      if (présentes.length === 0) {
        return;
      }
      if (!présentes.includes('start_reading')) {
        db.exec(`ALTER TABLE usage_records ADD COLUMN start_reading REAL;`);
        db.exec(`
          UPDATE usage_records SET start_reading = (
            SELECT MAX(précédent.meter_reading) FROM usage_records AS précédent
              WHERE précédent.equipment_id = usage_records.equipment_id
                AND précédent.meter_reading < usage_records.meter_reading
          );
        `);
      }
      if (nullable(db, 'usage_records', 'member_id')) {
        return;
      }
      // Reconstruction : SQLite ne sait pas relâcher un NOT NULL sur place. Aucune table ne
      // référence `usage_records` — le renommage n'a donc pas de clause `REFERENCES` fille à
      // préserver, et les clés étrangères peuvent rester armées pendant l'étape.
      db.exec(`
        ALTER TABLE usage_records RENAME TO usage_records_ancien;
        CREATE TABLE usage_records (
          id TEXT PRIMARY KEY,
          equipment_id TEXT NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
          member_id TEXT REFERENCES members(id),
          recorded_at TEXT NOT NULL,
          meter_reading REAL NOT NULL,
          start_reading REAL,
          fuel_added_liters REAL,
          notes TEXT,
          is_maintenance INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO usage_records
            (id, equipment_id, member_id, recorded_at, meter_reading, start_reading, fuel_added_liters, notes, is_maintenance)
          SELECT id, equipment_id, member_id, recorded_at, meter_reading, start_reading, fuel_added_liters, notes, is_maintenance
            FROM usage_records_ancien;
        DROP TABLE usage_records_ancien;
        CREATE INDEX IF NOT EXISTS idx_usage_equipment ON usage_records(equipment_id);
        CREATE INDEX IF NOT EXISTS idx_usage_member ON usage_records(member_id);
      `);
      const orphelines = db.pragma('foreign_key_check') as unknown[];
      if (orphelines.length > 0) {
        throw new Error(
          `Reconstruction de la table « usage_records » incohérente : ${orphelines.length} ligne(s) orpheline(s). ${BACKUP_FIRST}`,
        );
      }
    },
  },
];

/** Version de schéma attendue par ce code : rank de la dernière migration connue. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Applique les migrations manquantes, une transaction par étape : la version n'avance que si
 * l'étape a réussi entièrement. `PRAGMA user_version` est le seul état de référence — une base
 * antérieure au versionnement vaut 0 et rejoue la liste, dont chaque étape est sans effet sur ce
 * qui existe déjà.
 */
function migrate(db: SqliteDb): void {
  rejectIncompatibleSchema(db);
  const applied = Number(db.pragma('user_version', { simple: true }));
  for (let rank = applied; rank < MIGRATIONS.length; rank += 1) {
    const migration = MIGRATIONS[rank]!;
    const version = rank + 1;
    const étape = db.transaction(() => {
      migration.apply(db);
      // PRAGMA n'accepte pas de paramètre lié ; `version` est un entier issu de MIGRATIONS.
      db.pragma(`user_version = ${version}`);
    });
    if (!migration.withoutForeignKeys) {
      étape();
      continue;
    }
    // `PRAGMA foreign_keys` est sans effet à l'intérieur d'une transaction : le désarmement doit
    // encadrer celle-ci. La transaction reste entière — une étape qui échoue ne laisse rien
    // derrière elle — et les clés sont réarmées quoi qu'il arrive.
    db.pragma('foreign_keys = OFF');
    try {
      étape();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
}

/**
 * Les versions antérieures supprimaient (`DROP TABLE`) les schémas devenus incompatibles au
 * démarrage, sans trace ni sauvegarde. Sur un volume portant des données réelles, c'est une perte
 * irréversible que personne n'a décidée : on refuse désormais de démarrer et on laisse l'opérateur
 * trancher.
 */
function rejectIncompatibleSchema(db: SqliteDb): void {
  if (tableExists(db, 'groups')) {
    throw new Error(
      `Schéma incompatible : la table « groups » relève du modèle « collectif », abandonné. ${BACKUP_FIRST} ` +
        'Supprimez ensuite manuellement les tables de ce modèle (groups, group_members, equipment_access…).',
    );
  }
  const messages = columns(db, 'messages');
  if (messages.length > 0 && !messages.includes('thread_id')) {
    throw new Error(
      `Schéma incompatible : la table « messages » relève du mur de messages plat, antérieur aux fils. ${BACKUP_FIRST} ` +
        'Supprimez ensuite manuellement la table « messages ».',
    );
  }
}

function tableExists(db: SqliteDb, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

/** Vrai si la colonne existe et accepte NULL — de quoi rendre une reconstruction idempotente. */
function nullable(db: SqliteDb, table: string, column: string): boolean {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[];
  return info.some((c) => c.name === column && c.notnull === 0);
}

function columns(db: SqliteDb, table: string): string[] {
  // `PRAGMA table_info` d'une table absente renvoie une liste vide, sans lever.
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}
