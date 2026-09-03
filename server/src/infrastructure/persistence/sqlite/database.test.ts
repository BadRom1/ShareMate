import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, SCHEMA_VERSION } from './database.js';
import { SqliteMemberRepository } from './repositories.js';

let répertoire: string;
let fichier: string;

beforeEach(() => {
  répertoire = fs.mkdtempSync(path.join(os.tmpdir(), 'sharemate-migration-'));
  fichier = path.join(répertoire, 'base.sqlite');
});

afterEach(() => {
  fs.rmSync(répertoire, { recursive: true, force: true });
});

/** Base au schéma antérieur : ni `members.invited_by`, ni `member_credentials.invite_expires_at`. */
function baseAntérieure(): void {
  const db = new Database(fichier);
  db.exec(`
    CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT);
    CREATE TABLE member_credentials (
      member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
      password_hash TEXT,
      invite_code TEXT UNIQUE
    );
    INSERT INTO members (id, name) VALUES ('m1', 'Alice'), ('m2', 'Bruno');
    -- Compte ouvert, doublé d'un code : ce que produisait la régénération d'invitation d'alors.
    INSERT INTO member_credentials VALUES ('m1', 'hash-alice', 'code-vole');
    -- Invitation légitime, jamais consommée.
    INSERT INTO member_credentials VALUES ('m2', NULL, 'code-bruno');
  `);
  db.close();
}

function version(): number {
  const db = new Database(fichier);
  const valeur = Number(db.pragma('user_version', { simple: true }));
  db.close();
  return valeur;
}

describe('Migration du schéma', () => {
  it('révoque les codes posés au-dessus d’un mot de passe et date les invitations en attente', () => {
    baseAntérieure();
    const db = openDatabase(fichier);

    const alice = db.prepare(`SELECT * FROM member_credentials WHERE member_id = 'm1'`).get() as {
      password_hash: string | null;
      invite_code: string | null;
    };
    // Le code aurait permis de réécrire le mot de passe d'Alice : il ne survit pas à la migration.
    expect(alice.invite_code).toBeNull();
    expect(alice.password_hash).toBe('hash-alice');

    const bruno = db.prepare(`SELECT * FROM member_credentials WHERE member_id = 'm2'`).get() as {
      invite_code: string | null;
      invite_expires_at: string | null;
    };
    expect(bruno.invite_code).toBe('code-bruno');
    expect(new Date(bruno.invite_expires_at!).getTime()).toBeGreaterThan(Date.now());
    db.close();
  });

  it('ajoute les colonnes de réinitialisation, vides, et leur unicité', () => {
    baseAntérieure();
    const db = openDatabase(fichier);
    const colonnes = (db.prepare(`PRAGMA table_info(member_credentials)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(colonnes).toContain('reset_code');
    expect(colonnes).toContain('reset_expires_at');
    // Aucun compte existant n'a de reprise en cours : la migration n'en invente pas.
    expect(
      (db.prepare(`SELECT COUNT(*) AS c FROM member_credentials WHERE reset_code IS NOT NULL`).get() as { c: number })
        .c,
    ).toBe(0);

    // Deux comptes sans reprise cohabitent (index partiel), deux fois le même code, non.
    db.prepare(`UPDATE member_credentials SET reset_code = 'repris' WHERE member_id = 'm1'`).run();
    expect(() =>
      db.prepare(`UPDATE member_credentials SET reset_code = 'repris' WHERE member_id = 'm2'`).run(),
    ).toThrow();
    db.close();
  });

  it('ajoute l’invitant aux membres existants, sans le renseigner', () => {
    baseAntérieure();
    const db = openDatabase(fichier);
    const colonnes = (db.prepare(`PRAGMA table_info(members)`).all() as { name: string }[]).map((c) => c.name);
    expect(colonnes).toContain('invited_by');
    expect(
      (db.prepare(`SELECT invited_by FROM members WHERE id = 'm1'`).get() as { invited_by: string | null }).invited_by,
    ).toBeNull();
    db.close();
  });

  it('n’attribue le rôle d’administrateur à personne sur une base existante', () => {
    // Sur une base antérieure, aucun repère ne désigne le premier compte : `invited_by` vaut NULL
    // partout. Deviner ici donnerait à un inconnu le droit d'absorber n'importe quel compte —
    // l'opérateur tranche à froid, avec `npm run admin:designate`.
    baseAntérieure();
    const db = openDatabase(fichier);
    const colonnes = (db.prepare(`PRAGMA table_info(members)`).all() as { name: string }[]).map((c) => c.name);
    expect(colonnes).toContain('is_admin');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM members WHERE is_admin = 1`).get()).toEqual({ n: 0 });
    db.close();
  });

  it('est rejouable : une base déjà migrée traverse `migrate` sans dommage', () => {
    baseAntérieure();
    openDatabase(fichier).close();
    const db = openDatabase(fichier);
    const bruno = db.prepare(`SELECT * FROM member_credentials WHERE member_id = 'm2'`).get() as {
      invite_code: string | null;
    };
    expect(bruno.invite_code).toBe('code-bruno');
    db.close();
  });
});

describe('Migration « catégorie et valeur d’achat facultatives »', () => {
  /**
   * Base au schéma précédent, peuplée : la table `equipments` s'y reconstruit, et tout ce qui la
   * référence (cercle, réservations, dépenses, remboursements, relevés) doit y survivre — une
   * reconstruction naïve les emporterait par cascade.
   */
  function baseAvecHistorique(): void {
    const db = openDatabase(fichier);
    db.exec(`
      INSERT INTO members (id, name) VALUES ('m1', 'Alice'), ('m2', 'Bruno');
      INSERT INTO equipments (id, name, category, acquisition_date, purchase_value_cents, meter_unit, maintenance_threshold)
        VALUES ('e1', 'Minipelle', 'BTP', '2025-03-01T00:00:00.000Z', 1500000, 'HOURS', 50);
      INSERT INTO equipment_members VALUES ('e1', 'm1', 0), ('e1', 'm2', 1);
      INSERT INTO reservations (id, equipment_id, member_id, start_at, end_at, status, created_at)
        VALUES ('r1', 'e1', 'm1', '2026-01-01T08:00:00.000Z', '2026-01-01T10:00:00.000Z', 'PLANNED', '2025-12-01T00:00:00.000Z');
      INSERT INTO usage_records (id, equipment_id, member_id, recorded_at, meter_reading)
        VALUES ('u1', 'e1', 'm1', '2026-01-01T10:00:00.000Z', 120);
      INSERT INTO expenses (id, equipment_id, label, amount_cents, payer_id, date, category, split_json)
        VALUES ('d1', 'e1', 'Gasoil', 5000, 'm1', '2026-01-02T00:00:00.000Z', 'FUEL', '{"type":"EQUAL"}');
      INSERT INTO reimbursements (id, equipment_id, from_member_id, to_member_id, amount_cents, date)
        VALUES ('rb1', 'e1', 'm2', 'm1', 2500, '2026-01-03T00:00:00.000Z');
    `);
    // Version ramenée à l'étape précédente : la reconstruction reste à jouer.
    db.pragma(`user_version = ${SCHEMA_VERSION - 1}`);
    db.close();
  }

  /** Colonnes acceptant NULL, telles que déclarées par le schéma. */
  function facultatives(db: Database.Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[])
      .filter((c) => c.notnull === 0)
      .map((c) => c.name);
  }

  it('rend les deux colonnes facultatives sans rien perdre de l’historique de l’équipement', () => {
    baseAvecHistorique();
    const db = openDatabase(fichier);

    expect(facultatives(db, 'equipments')).toEqual(
      expect.arrayContaining(['category', 'purchase_value_cents', 'maintenance_threshold']),
    );
    // La reconstruction a conservé la ligne, ses valeurs, et tout ce qui pend à l'équipement.
    expect(db.prepare(`SELECT name, category, purchase_value_cents FROM equipments`).all()).toEqual([
      { name: 'Minipelle', category: 'BTP', purchase_value_cents: 1500000 },
    ]);
    for (const [table, attendu] of [
      ['equipment_members', 2],
      ['reservations', 1],
      ['usage_records', 1],
      ['expenses', 1],
      ['reimbursements', 1],
    ] as const) {
      expect({ table, n: (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n }).toEqual({
        table,
        n: attendu,
      });
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
    // Une fiche peut désormais s'écrire sans catégorie ni valeur d'achat.
    db.prepare(
      `INSERT INTO equipments (id, name, category, acquisition_date, purchase_value_cents, meter_unit, maintenance_threshold)
       VALUES ('e2', 'Bétonnière', NULL, '2025-04-01T00:00:00.000Z', NULL, 'HOURS', NULL)`,
    ).run();
    expect(version()).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('est sans effet sur une base déjà reconstruite', () => {
    baseAvecHistorique();
    openDatabase(fichier).close();
    const db = openDatabase(fichier);
    expect(db.prepare(`SELECT COUNT(*) n FROM equipment_members`).get()).toEqual({ n: 2 });
    db.close();
  });
});

describe('Migration « compteur de départ et relevés en attente d’attribution »', () => {
  /** Base au schéma précédent : `usage_records` sans départ, et dont le membre est obligatoire. */
  function baseSansCompteurDeDépart(): void {
    const db = new Database(fichier);
    db.exec(`
      CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT);
      CREATE TABLE equipments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT,
        acquisition_date TEXT NOT NULL,
        purchase_value_cents INTEGER,
        meter_unit TEXT NOT NULL,
        maintenance_threshold REAL
      );
      CREATE TABLE usage_records (
        id TEXT PRIMARY KEY,
        equipment_id TEXT NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id),
        recorded_at TEXT NOT NULL,
        meter_reading REAL NOT NULL,
        fuel_added_liters REAL,
        notes TEXT,
        is_maintenance INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO members (id, name) VALUES ('m1', 'Alice'), ('m2', 'Bruno');
      INSERT INTO equipments (id, name, acquisition_date, meter_unit)
        VALUES ('e1', 'Minipelle', '2025-03-01T00:00:00.000Z', 'HOURS'),
               ('e2', 'Bétonnière', '2025-04-01T00:00:00.000Z', 'HOURS');
      INSERT INTO usage_records (id, equipment_id, member_id, recorded_at, meter_reading, notes) VALUES
        ('u1', 'e1', 'm1', '2026-01-01T10:00:00.000Z', 100, 'RAS'),
        ('u2', 'e1', 'm2', '2026-01-02T10:00:00.000Z', 165.3, NULL),
        ('u3', 'e1', 'm1', '2026-01-03T10:00:00.000Z', 180, NULL),
        ('u4', 'e2', 'm1', '2026-01-04T10:00:00.000Z', 50, NULL),
        -- Deux relevés au même compteur : le second n'a rien fait tourner (durée nulle).
        ('u5', 'e2', 'm2', '2026-01-05T10:00:00.000Z', 80, NULL),
        ('u6', 'e2', 'm1', '2026-01-06T10:00:00.000Z', 80, NULL);
    `);
    db.close();
  }

  function départs(db: Database.Database): unknown[] {
    return db.prepare('SELECT id, start_reading FROM usage_records ORDER BY id').all();
  }

  it('donne à chaque relevé le compteur qui le précède dans la chaîne de son équipement', () => {
    baseSansCompteurDeDépart();
    const db = openDatabase(fichier);

    // Exactement ce que le calcul des durées déduisait jusqu'ici, écrit une fois pour toutes.
    // Le premier relevé de chaque équipement garde NULL : son compteur d'origine est inconnu.
    expect(départs(db)).toEqual([
      { id: 'u1', start_reading: null },
      { id: 'u2', start_reading: 100 },
      { id: 'u3', start_reading: 165.3 },
      { id: 'u4', start_reading: null },
      { id: 'u5', start_reading: 50 },
      // Le prédécesseur de `u6` est `u5`, à compteur égal : sa durée reste nulle. La chercher
      // strictement plus bas lui donnerait le départ de `u5` — et 30 h qu'il n'a jamais faites.
      { id: 'u6', start_reading: 80 },
    ]);
    expect(db.prepare(`SELECT notes FROM usage_records WHERE id = 'u1'`).get()).toEqual({ notes: 'RAS' });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(version()).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('accepte désormais un relevé sans membre : le segment en attente d’attribution', () => {
    baseSansCompteurDeDépart();
    const db = openDatabase(fichier);

    db.prepare(
      `INSERT INTO usage_records (id, equipment_id, member_id, recorded_at, meter_reading, start_reading)
       VALUES ('u9', 'e1', NULL, '2026-01-07T10:00:00.000Z', 200, 180)`,
    ).run();
    expect(db.prepare(`SELECT member_id FROM usage_records WHERE id = 'u9'`).get()).toEqual({ member_id: null });
    db.close();
  });

  it('est sans effet sur une base déjà migrée', () => {
    baseSansCompteurDeDépart();
    openDatabase(fichier).close();
    const db = openDatabase(fichier);

    expect(départs(db)).toEqual([
      { id: 'u1', start_reading: null },
      { id: 'u2', start_reading: 100 },
      { id: 'u3', start_reading: 165.3 },
      { id: 'u4', start_reading: null },
      { id: 'u5', start_reading: 50 },
      { id: 'u6', start_reading: 80 },
    ]);
    db.close();
  });
});

describe('Migration des emails de membres', () => {
  /** Base portant les emails que les versions antérieures acceptaient sans les valider. */
  function baseAvecEmailsLibres(): void {
    const db = openDatabase(fichier);
    db.exec(`
      INSERT INTO members (id, name, email) VALUES
        ('m1', 'Alice', ' alice@example.org '),
        ('m2', 'Bruno', 'pas une adresse'),
        ('m3', 'Chloé', 'ALICE@example.org'),
        ('m4', 'Denis', ''),
        ('m5', 'Emma', 'emma@example.org');
    `);
    db.pragma('user_version = 5'); // avant la migration des emails
    db.close();
  }

  function emails(): Record<string, string | null> {
    const db = new Database(fichier);
    const rows = db.prepare('SELECT id, email FROM members').all() as { id: string; email: string | null }[];
    db.close();
    return Object.fromEntries(rows.map((r) => [r.id, r.email]));
  }

  it('refuse de démarrer plutôt que d’effacer une adresse, en nommant les rangées fautives', () => {
    baseAvecEmailsLibres();
    // Effacer ces adresses en silence prive leur titulaire de son moyen de connexion sans qu'il
    // sache pourquoi : la perte n'est pas moins réelle pour tenir dans une colonne.
    expect(() => openDatabase(fichier)).toThrow(/Emails de membres incompatibles/);
    try {
      openDatabase(fichier);
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('m2 (Bruno) « pas une adresse » : forme invalide');
      expect(message).toContain('m3 (Chloé) « ALICE@example.org » : déjà porté par m1');
      expect(message).toContain('.backup'); // la sauvegarde d'abord
    }

    // Rien n'a été écrit : la migration est transactionnelle, la version n'a pas avancé.
    expect(emails()).toEqual({
      m1: ' alice@example.org ',
      m2: 'pas une adresse',
      m3: 'ALICE@example.org',
      m4: '',
      m5: 'emma@example.org',
    });
  });

  it('rogne et laisse tous les membres chargeables une fois les fautives corrigées', async () => {
    baseAvecEmailsLibres();
    const brute = new Database(fichier);
    brute.exec(`UPDATE members SET email = NULL WHERE id IN ('m2', 'm3')`);
    brute.close();

    const db = openDatabase(fichier);
    // Un champ laissé vide vaut « pas d'adresse » pour le domaine : le passer à NULL n'ôte rien.
    expect(emails()).toEqual({
      m1: 'alice@example.org', // rogné
      m2: null,
      m3: null,
      m4: null,
      m5: 'emma@example.org',
    });
    // C'est l'enjeu : une seule adresse survivante mal formée rendrait le membre illisible.
    const tous = ['m1', 'm2', 'm3', 'm4', 'm5'];
    expect((await new SqliteMemberRepository(db).findByIds(tous)).map((m) => m.name)).toHaveLength(5);
    db.close();
  });
});

describe('Versionnement du schéma (PRAGMA user_version)', () => {
  it('une base neuve reçoit le schéma complet et la version courante', () => {
    const db = openDatabase(fichier);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'equipment_members'`).get(),
    ).toBeTruthy();
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_equipment_members_member'`).get(),
    ).toBeTruthy();
    db.close();
  });

  it('une base antérieure au versionnement est migrée puis marquée, sans perte de données', () => {
    baseAntérieure();
    expect(version()).toBe(0);
    openDatabase(fichier).close();
    expect(version()).toBe(SCHEMA_VERSION);

    const db = new Database(fichier);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM members`).get() as { c: number }).c).toBe(2);
    db.close();
  });

  it('une base au schéma courant mais non versionnée est reconnue et marquée telle quelle', () => {
    // Cas de la base en production : elle a déjà tout le schéma, mais `user_version` vaut 0 faute
    // d'avoir jamais été posé. Rejouer la liste ne doit rien coûter et surtout rien détruire.
    const db = openDatabase(fichier);
    db.exec(`
      INSERT INTO members (id, name) VALUES ('m1', 'Alice'), ('m2', 'Bruno');
      INSERT INTO equipments VALUES ('e1', 'Minipelle', 'BTP', '2025-01-01', 1500000, 'HOURS', 50);
      INSERT INTO equipment_members VALUES ('e1', 'm1', 0), ('e1', 'm2', 1);
      INSERT INTO member_credentials (member_id, password_hash) VALUES ('m1', 'hash-alice');
    `);
    db.pragma('user_version = 0');
    db.close();

    openDatabase(fichier).close();

    expect(version()).toBe(SCHEMA_VERSION);
    const relu = new Database(fichier);
    expect((relu.prepare(`SELECT COUNT(*) AS c FROM equipment_members`).get() as { c: number }).c).toBe(2);
    expect(
      (
        relu.prepare(`SELECT password_hash FROM member_credentials WHERE member_id = 'm1'`).get() as {
          password_hash: string | null;
        }
      ).password_hash,
    ).toBe('hash-alice');
    relu.close();
  });

  it('une base déjà à jour ne rejoue aucune migration', () => {
    const db = openDatabase(fichier);
    db.exec(`
      INSERT INTO members (id, name) VALUES ('m1', 'Alice');
      INSERT INTO member_credentials (member_id, invite_code) VALUES ('m1', 'code-alice');
    `);
    db.close();

    openDatabase(fichier).close();

    // Le correctif de données de la version 4 daterait cette invitation : il ne doit plus tourner.
    const relu = new Database(fichier);
    expect(
      (
        relu.prepare(`SELECT invite_expires_at FROM member_credentials WHERE member_id = 'm1'`).get() as {
          invite_expires_at: string | null;
        }
      ).invite_expires_at,
    ).toBeNull();
    relu.close();
  });

  it('une base à une version intermédiaire ne rejoue que les migrations manquantes', () => {
    const db = openDatabase(fichier);
    db.exec(`
      INSERT INTO members (id, name) VALUES ('m1', 'Alice');
      INSERT INTO member_credentials (member_id, invite_code) VALUES ('m1', 'code-alice');
      DROP INDEX idx_equipment_members_member;
    `);
    db.pragma('user_version = 3');
    db.close();

    openDatabase(fichier).close();

    expect(version()).toBe(SCHEMA_VERSION);
    const relu = new Database(fichier);
    // La migration 4, redevenue en attente, date bien l'invitation…
    expect(
      (
        relu.prepare(`SELECT invite_expires_at FROM member_credentials WHERE member_id = 'm1'`).get() as {
          invite_expires_at: string | null;
        }
      ).invite_expires_at,
    ).not.toBeNull();
    // …et la 5 recrée l'index supprimé.
    expect(
      relu
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_equipment_members_member'`)
        .get(),
    ).toBeTruthy();
    relu.close();
  });
});

describe('Schémas incompatibles', () => {
  it('refuse de démarrer sur l’ancien modèle « collectif » plutôt que de le supprimer', () => {
    const db = new Database(fichier);
    db.exec(`
      CREATE TABLE "groups" (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO "groups" VALUES ('g1', 'Les voisins');
    `);
    db.close();

    expect(() => openDatabase(fichier)).toThrow(/groups/);

    // Les données sont intactes : c'est à l'opérateur de trancher, sauvegarde en main.
    const relu = new Database(fichier);
    expect((relu.prepare(`SELECT COUNT(*) AS c FROM "groups"`).get() as { c: number }).c).toBe(1);
    expect(Number(relu.pragma('user_version', { simple: true }))).toBe(0);
    relu.close();
  });

  it('refuse de démarrer sur le mur de messages plat plutôt que de le supprimer', () => {
    const db = new Database(fichier);
    db.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, equipment_id TEXT NOT NULL, body TEXT NOT NULL);
      INSERT INTO messages VALUES ('msg1', 'e1', 'Bonjour');
    `);
    db.close();

    expect(() => openDatabase(fichier)).toThrow(/messages/);

    const relu = new Database(fichier);
    expect((relu.prepare(`SELECT COUNT(*) AS c FROM messages`).get() as { c: number }).c).toBe(1);
    relu.close();
  });
});
