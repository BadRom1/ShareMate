import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import type { SqliteDb } from './database.js';
import {
  SqliteCredentialRepository,
  SqliteEquipmentRepository,
  SqliteExpenseRepository,
  SqliteMemberRepository,
  SqliteReimbursementRepository,
  SqliteReservationRepository,
  SqliteSessionRepository,
  SqliteUsageRecordRepository,
} from './repositories.js';
import { Member } from '../../../domain/member/member.js';
import { MemberCredential } from '../../../domain/auth/credential.js';
import { Equipment } from '../../../domain/equipment/equipment.js';
import { Reservation } from '../../../domain/reservation/reservation.js';
import { UsageRecord } from '../../../domain/usage/usage-record.js';
import { Expense } from '../../../domain/expense/expense.js';
import { Reimbursement } from '../../../domain/expense/reimbursement.js';
import { Money } from '../../../domain/shared/money.js';
import { TimeRange } from '../../../domain/shared/time-range.js';

let db: SqliteDb;

beforeEach(() => {
  db = openDatabase(':memory:');
});

async function seedBase() {
  const members = new SqliteMemberRepository(db);
  const equipments = new SqliteEquipmentRepository(db);
  await members.save(Member.create({ id: 'm1', name: 'Alice' }));
  await members.save(Member.create({ id: 'm2', name: 'Bruno', email: 'b@ex.fr' }));
  await equipments.save(
    Equipment.create({
      id: 'e1',
      name: 'Minipelle',
      category: 'BTP',
      acquisitionDate: new Date('2025-01-01T00:00:00Z'),
      purchaseValue: Money.fromEuros(15000),
      meterUnit: 'HOURS',
      memberIds: ['m1', 'm2'],
      maintenanceThreshold: 50,
    }),
  );
  return { members, equipments };
}

describe('SQLite — membres', () => {
  it('sauve et relit un membre', async () => {
    const { members } = await seedBase();
    const m = await members.findById('m2');
    expect(m?.name).toBe('Bruno');
    expect(m?.email).toBe('b@ex.fr');
  });

  it('liste tous les membres triés par nom', async () => {
    const { members } = await seedBase();
    expect((await members.findAll()).map((m) => m.name)).toEqual(['Alice', 'Bruno']);
  });
});

describe('SQLite — accès (credentials)', () => {
  it('sauve, relit et compte les accès ; retrouve par code d’invitation', async () => {
    await seedBase();
    const credentials = new SqliteCredentialRepository(db);
    expect(await credentials.count()).toBe(0);

    await credentials.save(MemberCredential.create({ memberId: 'm1', passwordHash: 'hash-alice' }));
    await credentials.save(MemberCredential.create({ memberId: 'm2', inviteCode: 'code-bruno' }));
    expect(await credentials.count()).toBe(2);

    expect((await credentials.findByMemberId('m1'))?.passwordHash).toBe('hash-alice');
    expect((await credentials.findByInviteCode('code-bruno'))?.memberId).toBe('m2');
    expect(await credentials.findByInviteCode('inconnu')).toBeNull();
  });

  it('la mise à jour écrase mot de passe et invitation', async () => {
    await seedBase();
    const credentials = new SqliteCredentialRepository(db);
    await credentials.save(MemberCredential.create({ memberId: 'm2', inviteCode: 'code-bruno' }));
    const claimed = (await credentials.findByInviteCode('code-bruno'))!.withPassword('hash-bruno');
    await credentials.save(claimed);
    expect(await credentials.findByInviteCode('code-bruno')).toBeNull();
    expect((await credentials.findByMemberId('m2'))?.passwordHash).toBe('hash-bruno');
  });
});

describe('SQLite — sessions', () => {
  it('sauve, relit, supprime et purge les sessions expirées', async () => {
    await seedBase();
    const sessions = new SqliteSessionRepository(db);
    await sessions.save({ tokenHash: 't1', memberId: 'm1', expiresAt: new Date('2026-08-01T00:00:00Z') });
    await sessions.save({ tokenHash: 't2', memberId: 'm2', expiresAt: new Date('2026-07-01T00:00:00Z') });

    const found = await sessions.findByTokenHash('t1');
    expect(found?.memberId).toBe('m1');
    expect(found?.expiresAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');

    await sessions.deleteExpired(new Date('2026-07-15T00:00:00Z'));
    expect(await sessions.findByTokenHash('t2')).toBeNull();
    expect(await sessions.findByTokenHash('t1')).not.toBeNull();

    await sessions.delete('t1');
    expect(await sessions.findByTokenHash('t1')).toBeNull();
  });
});

describe('SQLite — équipements', () => {
  it('roundtrip complet avec le cercle ordonné', async () => {
    const { equipments } = await seedBase();
    const e = await equipments.findById('e1');
    expect(e?.name).toBe('Minipelle');
    expect(e?.purchaseValue.cents).toBe(1500000);
    expect(e?.memberIds).toEqual(['m1', 'm2']);
    expect(e?.maintenanceThreshold).toBe(50);
  });

  it('met à jour le cercle (upsert)', async () => {
    const { members, equipments } = await seedBase();
    await members.save(Member.create({ id: 'm3', name: 'Chloé' }));
    const e = (await equipments.findById('e1'))!;
    await equipments.save(e.update({ memberIds: ['m1', 'm2', 'm3'] }));
    expect((await equipments.findById('e1'))?.memberIds).toEqual(['m1', 'm2', 'm3']);
  });

  it('liste tout et supprime', async () => {
    const { equipments } = await seedBase();
    expect(await equipments.findAll()).toHaveLength(1);
    await equipments.delete('e1');
    expect(await equipments.findAll()).toHaveLength(0);
  });
});

describe('SQLite — réservations', () => {
  it('roundtrip et requêtes par équipement / globales', async () => {
    await seedBase();
    const repo = new SqliteReservationRepository(db);
    await repo.save(
      Reservation.create({
        id: 'r1',
        equipmentId: 'e1',
        memberId: 'm1',
        range: TimeRange.create(new Date('2026-07-10T08:00:00Z'), new Date('2026-07-10T12:00:00Z')),
        notes: 'tranchée',
      }),
    );
    const r = await repo.findById('r1');
    expect(r?.range.start.toISOString()).toBe('2026-07-10T08:00:00.000Z');
    expect(r?.notes).toBe('tranchée');
    expect(await repo.findByEquipmentId('e1')).toHaveLength(1);
    expect(await repo.findAll()).toHaveLength(1);
    await repo.delete('r1');
    expect(await repo.findById('r1')).toBeNull();
  });
});

describe("SQLite — relevés d'usage", () => {
  it('roundtrip par équipement et par membre', async () => {
    await seedBase();
    const repo = new SqliteUsageRecordRepository(db);
    await repo.save(
      UsageRecord.create({
        id: 'u1',
        equipmentId: 'e1',
        memberId: 'm1',
        recordedAt: new Date('2026-07-02T10:00:00Z'),
        meterReading: 120.5,
        fuelAddedLiters: 15,
        notes: 'RAS',
        isMaintenance: true,
      }),
    );
    const byEq = await repo.findByEquipmentId('e1');
    expect(byEq[0]?.meterReading).toBe(120.5);
    expect(byEq[0]?.isMaintenance).toBe(true);
    expect(await repo.findByMemberId('m1')).toHaveLength(1);
  });
});

describe('SQLite — dépenses et remboursements', () => {
  it("roundtrip d'une dépense avec répartition custom", async () => {
    await seedBase();
    const repo = new SqliteExpenseRepository(db);
    await repo.save(
      Expense.create({
        id: 'x1',
        equipmentId: 'e1',
        label: 'Plein',
        amount: Money.fromCents(1000),
        payerId: 'm1',
        date: new Date('2026-07-01T00:00:00Z'),
        category: 'FUEL',
        split: { type: 'CUSTOM', amounts: { m1: Money.fromCents(700), m2: Money.fromCents(300) } },
        receiptPath: '/uploads/r.pdf',
      }),
    );
    const x = await repo.findById('x1');
    expect(x?.amount.cents).toBe(1000);
    expect(x?.shares().get('m1')?.cents).toBe(700);
    expect(x?.receiptPath).toBe('/uploads/r.pdf');
    expect(await repo.findByEquipmentId('e1')).toHaveLength(1);
    await repo.delete('x1');
    expect(await repo.findById('x1')).toBeNull();
  });

  it("roundtrip d'une répartition au prorata", async () => {
    await seedBase();
    const repo = new SqliteExpenseRepository(db);
    await repo.save(
      Expense.create({
        id: 'x2',
        equipmentId: 'e1',
        label: 'Assurance',
        amount: Money.fromCents(20000),
        payerId: 'm2',
        date: new Date('2026-07-01T00:00:00Z'),
        category: 'INSURANCE',
        split: { type: 'USAGE_PRORATED', weights: { m1: 3, m2: 1 } },
      }),
    );
    const x = await repo.findById('x2');
    expect(x?.shares().get('m1')?.cents).toBe(15000);
  });

  it("roundtrip d'un remboursement", async () => {
    await seedBase();
    const repo = new SqliteReimbursementRepository(db);
    await repo.save(
      Reimbursement.create({
        id: 'rb1',
        equipmentId: 'e1',
        fromMemberId: 'm2',
        toMemberId: 'm1',
        amount: Money.fromCents(500),
        date: new Date('2026-07-02T00:00:00Z'),
        notes: 'virement',
      }),
    );
    const list = await repo.findByEquipmentId('e1');
    expect(list).toHaveLength(1);
    expect(list[0]?.amount.cents).toBe(500);
    expect(list[0]?.notes).toBe('virement');
  });
});

describe("SQLite — migration depuis l'ancien modèle « collectif »", () => {
  it("détecte l'ancien schéma et repart de zéro", async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharemate-test-'));
    const file = path.join(dir, 'legacy.sqlite');
    try {
      const legacy = openDatabase(file);
      legacy.exec(`
        CREATE TABLE "groups" (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO "groups" VALUES ('g1', 'Les voisins');
      `);
      legacy.close();
      // Réouvre la même base : la migration doit purger l'ancien schéma.
      const migrated = openDatabase(file);
      expect(
        migrated.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'groups'`).get(),
      ).toBeUndefined();
      expect(
        migrated.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'equipment_members'`).get(),
      ).toBeTruthy();
      migrated.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
