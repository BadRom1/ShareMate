import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import type { SqliteDb } from './database.js';
import { SqliteMemberMerger } from './member-merge.js';
import { SqliteExpenseRepository, SqliteMemberRepository, SqliteReimbursementRepository } from './repositories.js';
import { computeBalances } from '../../../domain/expense/settlement.js';
import { DomainError, NotFoundError } from '../../../domain/shared/domain-error.js';

/**
 * Fusion de deux comptes, éprouvée sur la base réelle.
 *
 * C'est le seul niveau où elle se laisse vérifier : les pièges qu'elle doit désamorcer sont des
 * clés primaires composées, des clés étrangères armées et un champ JSON hors de leur portée. Un
 * double en mémoire n'en porte aucun.
 *
 * Le cas joué est celui qui a fait naître la demande : Damien existe deux fois — l'ancien compte
 * porte l'historique, le nouveau porte l'accès qui fonctionne —, et l'ancien est absorbé.
 */

let db: SqliteDb;

const ANCIEN = 'damien-ancien';
const NOUVEAU = 'damien-nouveau';

/** État de départ : deux Damien, deux équipements, et de quoi toucher chaque table. */
function semer(): void {
  db.exec(`
    INSERT INTO members (id, name, email, invited_by, is_admin) VALUES
      ('alice', 'Alice', 'alice@example.org', NULL, 1),
      ('${ANCIEN}', 'Damien', 'damien@example.org', 'alice', 0),
      ('${NOUVEAU}', 'Damien', NULL, 'alice', 0),
      ('chloe', 'Chloé', NULL, '${ANCIEN}', 0);

    INSERT INTO equipments (id, name, category, acquisition_date, purchase_value_cents, meter_unit, maintenance_threshold)
      VALUES ('e1', 'Bétonnière', 'BTP', '2025-01-01T00:00:00.000Z', 90000, 'HOURS', NULL),
             ('e2', 'Remorque', NULL, '2025-01-01T00:00:00.000Z', NULL, 'KILOMETERS', NULL);

    -- e1 : les deux comptes y figurent (collision de clé primaire à la réécriture).
    INSERT INTO equipment_members (equipment_id, member_id, position) VALUES
      ('e1', 'alice', 0), ('e1', '${ANCIEN}', 1), ('e1', '${NOUVEAU}', 2), ('e1', 'chloe', 3),
      ('e2', 'alice', 0), ('e2', '${ANCIEN}', 1);

    INSERT INTO reservations (id, equipment_id, member_id, start_at, end_at, status, created_at, notes)
      VALUES ('r1', 'e1', '${ANCIEN}', '2026-07-01T08:00:00.000Z', '2026-07-01T12:00:00.000Z', 'PLANNED', '2026-06-01T08:00:00.000Z', NULL);

    INSERT INTO usage_records (id, equipment_id, member_id, recorded_at, meter_reading, fuel_added_liters, notes, is_maintenance)
      VALUES ('u1', 'e1', '${ANCIEN}', '2026-07-01T12:00:00.000Z', 12.5, NULL, NULL, 0);

    -- x1 : les deux comptes dans la même répartition égale — les parts devront s'additionner.
    INSERT INTO expenses (id, equipment_id, label, amount_cents, payer_id, date, category, split_json, receipt_path)
      VALUES ('x1', 'e1', 'Gasoil', 9000, '${ANCIEN}', '2026-07-01T00:00:00.000Z', 'FUEL',
              '{"type":"EQUAL","memberIds":["${ANCIEN}","${NOUVEAU}","chloe"]}', NULL),
             ('x2', 'e1', 'Vidange', 6000, 'alice', '2026-06-01T00:00:00.000Z', 'MAINTENANCE',
              '{"type":"CUSTOM","amountsCents":{"${ANCIEN}":2000,"alice":4000}}', NULL);

    -- rb1 deviendra un remboursement de soi à soi ; rb2 change simplement de titulaire.
    INSERT INTO reimbursements (id, equipment_id, from_member_id, to_member_id, amount_cents, date, notes)
      VALUES ('rb1', 'e1', '${ANCIEN}', '${NOUVEAU}', 1500, '2026-07-02T00:00:00.000Z', NULL),
             ('rb2', 'e1', '${ANCIEN}', 'alice', 2500, '2026-07-03T00:00:00.000Z', NULL);

    INSERT INTO threads (id, equipment_id, author_id, title, created_at, updated_at)
      VALUES ('t1', 'e1', '${ANCIEN}', 'Bruit suspect', '2026-06-01T08:00:00.000Z', '2026-06-01T08:00:00.000Z');
    INSERT INTO messages (id, thread_id, author_id, body, created_at, edited_at, parent_id)
      VALUES ('msg1', 't1', '${ANCIEN}', 'Ça claque au démarrage.', '2026-06-01T08:00:00.000Z', NULL, NULL);

    INSERT INTO checklists (id, equipment_id, author_id, title, created_at, updated_at)
      VALUES ('c1', 'e1', '${ANCIEN}', 'Avant utilisation', '2026-06-01T08:00:00.000Z', '2026-06-01T08:00:00.000Z');
    INSERT INTO checklist_items (id, checklist_id, label, position, checked_at, checked_by_id)
      VALUES ('ci1', 'c1', 'Niveau d’huile', 0, '2026-06-02T08:00:00.000Z', '${ANCIEN}');

    INSERT INTO documents (id, equipment_id, author_id, name, category, created_at, storage_key, file_name, content_type, size_bytes, url)
      VALUES ('d1', 'e1', '${ANCIEN}', 'Manuel', 'MANUAL', '2026-06-01T08:00:00.000Z', NULL, NULL, NULL, NULL, 'https://example.org/manuel.pdf');

    INSERT INTO notifications (id, recipient_id, type, title, body, link, created_at, read_at)
      VALUES ('n1', '${ANCIEN}', 'EXPENSE_ADDED', 'Nouvelle dépense', 'Gasoil', NULL, '2026-07-01T08:00:00.000Z', NULL);

    -- MESSAGE_POSTED est réglé des deux côtés (collision) ; EXPENSE_ADDED du seul absorbé.
    INSERT INTO notification_preferences (member_id, type, in_app, push) VALUES
      ('${ANCIEN}', 'MESSAGE_POSTED', 0, 0),
      ('${ANCIEN}', 'EXPENSE_ADDED', 0, 1),
      ('${NOUVEAU}', 'MESSAGE_POSTED', 1, 1);

    INSERT INTO push_subscriptions (endpoint, member_id, p256dh, auth)
      VALUES ('https://push.example.org/abc', '${ANCIEN}', 'p', 'a');

    INSERT INTO member_credentials (member_id, password_hash, invite_code, invite_expires_at)
      VALUES ('${ANCIEN}', 'empreinte', NULL, NULL), ('${NOUVEAU}', 'empreinte', NULL, NULL);
    INSERT INTO sessions (token_hash, member_id, expires_at)
      VALUES ('jeton-telephone', '${ANCIEN}', '2099-01-01T00:00:00.000Z'),
             ('jeton-nouveau', '${NOUVEAU}', '2099-01-01T00:00:00.000Z');
  `);
  // Le nouveau compte a été créé par l'ancien : la fusion ne doit pas le rendre son propre invitant.
  db.prepare('UPDATE members SET invited_by = ? WHERE id = ?').run(ANCIEN, NOUVEAU);
}

/** Soldes de l'équipement, tels que les calcule l'application. */
async function soldes(equipmentId: string): Promise<Map<string, number>> {
  const expenses = await new SqliteExpenseRepository(db).findByEquipmentId(equipmentId);
  const reimbursements = await new SqliteReimbursementRepository(db).findByEquipmentId(equipmentId);
  return new Map([...computeBalances(expenses, reimbursements)].map(([id, m]) => [id, m.cents]));
}

function compter(sql: string, ...params: unknown[]): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...params) as { n: number }).n;
}

const plan = { absorbedId: ANCIEN, keptId: NOUVEAU, name: 'Damien', email: 'damien@example.org' };

beforeEach(() => {
  db = openDatabase(':memory:');
  semer();
});

describe('Fusion de comptes — ce qui est déplacé', () => {
  it('fait disparaître l’absorbé, son accès et ses sessions', async () => {
    const counts = await new SqliteMemberMerger(db).merge(plan);

    expect(compter('members WHERE id = ?', ANCIEN)).toBe(0);
    expect(compter('member_credentials WHERE member_id = ?', ANCIEN)).toBe(0);
    // Le téléphone resté connecté sur le compte fantôme est sorti de sa boucle.
    expect(compter('sessions WHERE member_id = ?', ANCIEN)).toBe(0);
    expect(compter('sessions WHERE member_id = ?', NOUVEAU)).toBe(1);
    expect(counts.sessionsRevoked).toBe(1);
  });

  it('retient l’identité choisie pour le compte conservé', async () => {
    await new SqliteMemberMerger(db).merge({ ...plan, name: 'Damien L.', email: 'damien@example.org' });
    const membre = await new SqliteMemberRepository(db).findById(NOUVEAU);
    expect(membre?.name).toBe('Damien L.');
    expect(membre?.email).toBe('damien@example.org');
  });

  it('réunit les deux lignes d’un même cercle sans violer la clé primaire, et resserre les positions', async () => {
    const counts = await new SqliteMemberMerger(db).merge(plan);

    const cercle = db
      .prepare('SELECT member_id, position FROM equipment_members WHERE equipment_id = ? ORDER BY position')
      .all('e1') as { member_id: string; position: number }[];
    expect(cercle.map((l) => l.member_id)).toEqual(['alice', NOUVEAU, 'chloe']);
    expect(cercle.map((l) => l.position)).toEqual([0, 1, 2]);
    // e2 ne portait que l'ancien : la ligne change simplement de titulaire.
    expect(compter('equipment_members WHERE equipment_id = ? AND member_id = ?', 'e2', NOUVEAU)).toBe(1);
    expect(counts.circlesMerged).toBe(1);
    expect(counts.circles).toBe(1);
  });

  it('repointe réservations, relevés, fils, messages, checklists, documents et notifications', async () => {
    const counts = await new SqliteMemberMerger(db).merge(plan);

    expect(compter('reservations WHERE member_id = ?', NOUVEAU)).toBe(1);
    expect(compter('usage_records WHERE member_id = ?', NOUVEAU)).toBe(1);
    expect(compter('threads WHERE author_id = ?', NOUVEAU)).toBe(1);
    expect(compter('messages WHERE author_id = ?', NOUVEAU)).toBe(1);
    expect(compter('checklists WHERE author_id = ?', NOUVEAU)).toBe(1);
    expect(compter('checklist_items WHERE checked_by_id = ?', NOUVEAU)).toBe(1);
    expect(compter('documents WHERE author_id = ?', NOUVEAU)).toBe(1);
    // Réécrites avant la disparition de l'absorbé : sans cela, la cascade emporterait son centre.
    expect(compter('notifications WHERE recipient_id = ?', NOUVEAU)).toBe(1);
    expect(compter('push_subscriptions WHERE member_id = ?', NOUVEAU)).toBe(1);
    expect(counts).toMatchObject({
      reservations: 1,
      usageRecords: 1,
      threads: 1,
      messages: 1,
      checklists: 1,
      checklistItems: 1,
      documents: 1,
      notifications: 1,
      pushSubscriptions: 1,
      expensesPaid: 1,
    });
  });

  it('garde les préférences du compte conservé, reprend celles que lui seul n’avait pas réglées', async () => {
    const counts = await new SqliteMemberMerger(db).merge(plan);

    const préférences = db
      .prepare('SELECT type, in_app, push FROM notification_preferences WHERE member_id = ? ORDER BY type')
      .all(NOUVEAU) as { type: string; in_app: number; push: number }[];
    expect(préférences).toEqual([
      { type: 'EXPENSE_ADDED', in_app: 0, push: 1 },
      { type: 'MESSAGE_POSTED', in_app: 1, push: 1 },
    ]);
    expect(counts.notificationPreferences).toBe(1);
    expect(counts.notificationPreferencesDropped).toBe(1);
  });

  it('rattache les invités de l’absorbé, sans rendre le conservé son propre invitant', async () => {
    const counts = await new SqliteMemberMerger(db).merge(plan);

    const invitants = db.prepare('SELECT id, invited_by FROM members ORDER BY id').all() as {
      id: string;
      invited_by: string | null;
    }[];
    expect(invitants).toEqual([
      { id: 'alice', invited_by: null },
      { id: 'chloe', invited_by: NOUVEAU },
      { id: NOUVEAU, invited_by: null },
    ]);
    expect(counts.invitedMembers).toBe(1);
  });

  it('supprime le remboursement devenu « de soi à soi », repointe les autres', async () => {
    const counts = await new SqliteMemberMerger(db).merge(plan);

    const restants = db.prepare('SELECT id, from_member_id, to_member_id FROM reimbursements').all() as {
      id: string;
      from_member_id: string;
      to_member_id: string;
    }[];
    expect(restants).toEqual([{ id: 'rb2', from_member_id: NOUVEAU, to_member_id: 'alice' }]);
    expect(counts.reimbursementsRemoved).toBe(1);
    expect(counts.reimbursements).toBe(1);
  });
});

describe('Fusion de comptes — répartitions de dépense', () => {
  it('additionne les parts là où les deux comptes figuraient, et la dépense se recharge', async () => {
    const counts = await new SqliteMemberMerger(db).merge(plan);

    const dépenses = await new SqliteExpenseRepository(db).findByEquipmentId('e1');
    const gasoil = dépenses.find((d) => d.id === 'x1')!;
    const parts = gasoil.shares();
    // 30 € + 30 €, et non les 45 € d'un partage à deux.
    expect(parts.get(NOUVEAU)!.cents).toBe(6000);
    expect(parts.get('chloe')!.cents).toBe(3000);
    expect([...parts.values()].reduce((s, m) => s + m.cents, 0)).toBe(9000);
    expect(gasoil.payerId).toBe(NOUVEAU);

    // La répartition personnalisée change seulement de titulaire.
    const vidange = dépenses.find((d) => d.id === 'x2')!;
    expect(vidange.shares().get(NOUVEAU)!.cents).toBe(2000);

    expect(counts.expenseSplits).toBe(2);
  });

  it('ne laisse plus aucune répartition nommer l’absorbé', async () => {
    await new SqliteMemberMerger(db).merge(plan);
    expect(compter('expenses WHERE instr(split_json, ?) > 0', ANCIEN)).toBe(0);
  });

  it('laisse les soldes de l’équipement inchangés, les deux lignes réunies', async () => {
    const avant = await soldes('e1');
    await new SqliteMemberMerger(db).merge(plan);
    const après = await soldes('e1');

    expect(après.get(NOUVEAU)).toBe((avant.get(ANCIEN) ?? 0) + (avant.get(NOUVEAU) ?? 0));
    expect(après.get('chloe')).toBe(avant.get('chloe'));
    expect(après.get('alice')).toBe(avant.get('alice'));
    expect(après.has(ANCIEN)).toBe(false);
    // Les soldes s'apurent toujours entre eux.
    expect([...après.values()].reduce((s, c) => s + c, 0)).toBe(0);
  });
});

describe('Fusion de comptes — tout ou rien', () => {
  it('ne laisse rien derrière elle quand une dépense refuse d’être relue', async () => {
    // Répartition incohérente écrite avant la règle de validation : la somme ne fait pas le montant.
    db.prepare('UPDATE expenses SET split_json = ? WHERE id = ?').run(
      `{"type":"CUSTOM","amountsCents":{"${ANCIEN}":1}}`,
      'x2',
    );

    await expect(new SqliteMemberMerger(db).merge(plan)).rejects.toThrow(DomainError);

    // Tout ce que la fusion avait déjà réécrit est revenu à sa place.
    expect(compter('members WHERE id = ?', ANCIEN)).toBe(1);
    expect(compter('reservations WHERE member_id = ?', ANCIEN)).toBe(1);
    expect(compter('sessions WHERE member_id = ?', ANCIEN)).toBe(1);
    expect(compter('reimbursements')).toBe(2);
  });

  it('refuse un compte absorbé inconnu, ou une fusion avec soi-même', async () => {
    const merger = new SqliteMemberMerger(db);
    await expect(merger.merge({ ...plan, absorbedId: 'inconnu' })).rejects.toThrow(NotFoundError);
    await expect(merger.merge({ ...plan, absorbedId: NOUVEAU })).rejects.toThrow(DomainError);
    expect(compter('members')).toBe(4);
  });
});

describe('Fusion de comptes — aperçu', () => {
  it('annonce exactement ce que la fusion fera, sans rien écrire', async () => {
    const merger = new SqliteMemberMerger(db);
    const annoncé = await merger.preview(ANCIEN, NOUVEAU);

    // Rien n'a bougé : l'aperçu est la fusion, défaite avant de rendre la main.
    expect(compter('members WHERE id = ?', ANCIEN)).toBe(1);
    expect(compter('sessions WHERE member_id = ?', ANCIEN)).toBe(1);
    expect(compter('reimbursements')).toBe(2);

    expect(await merger.merge(plan)).toEqual(annoncé);
  });

  it('échoue là où la fusion échouerait', async () => {
    const merger = new SqliteMemberMerger(db);
    await expect(merger.preview(ANCIEN, 'inconnu')).rejects.toThrow(NotFoundError);
    await expect(merger.preview('inconnu', NOUVEAU)).rejects.toThrow(NotFoundError);
  });
});
