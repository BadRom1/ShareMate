import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, SCHEMA_VERSION } from './database.js';

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
