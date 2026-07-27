import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from './database.js';

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
