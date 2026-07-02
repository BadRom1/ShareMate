import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import type { SqliteDb } from './database.js';
import {
  SqliteEquipmentRepository,
  SqliteExpenseRepository,
  SqliteGroupRepository,
  SqliteMemberRepository,
  SqliteReimbursementRepository,
  SqliteReservationRepository,
  SqliteUsageRecordRepository,
} from './repositories.js';
import { Member } from '../../../domain/group/member.js';
import { Group } from '../../../domain/group/group.js';
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
  const groups = new SqliteGroupRepository(db);
  const equipments = new SqliteEquipmentRepository(db);
  await members.save(Member.create({ id: 'm1', name: 'Alice' }));
  await members.save(Member.create({ id: 'm2', name: 'Bruno', email: 'b@ex.fr' }));
  await groups.save(Group.create({ id: 'g1', name: 'Les voisins', memberIds: ['m1', 'm2'] }));
  await equipments.save(
    Equipment.create({
      id: 'e1',
      groupId: 'g1',
      name: 'Minipelle',
      category: 'BTP',
      acquisitionDate: new Date('2025-01-01T00:00:00Z'),
      purchaseValue: Money.fromEuros(15000),
      meterUnit: 'HOURS',
      accessMemberIds: ['m1', 'm2'],
      maintenanceThreshold: 50,
    }),
  );
  return { members, groups, equipments };
}

describe('SQLite — membres et groupes', () => {
  it('sauve et relit un membre', async () => {
    const { members } = await seedBase();
    const m = await members.findById('m2');
    expect(m?.name).toBe('Bruno');
    expect(m?.email).toBe('b@ex.fr');
  });

  it('sauve et relit un groupe avec ses membres ordonnés', async () => {
    const { groups } = await seedBase();
    const g = await groups.findById('g1');
    expect(g?.memberIds).toEqual(['m1', 'm2']);
  });

  it('met à jour un groupe (upsert)', async () => {
    const { groups, members } = await seedBase();
    await members.save(Member.create({ id: 'm3', name: 'Chloé' }));
    const g = (await groups.findById('g1'))!;
    await groups.save(g.addMember('m3'));
    expect((await groups.findById('g1'))?.memberIds).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('SQLite — équipements', () => {
  it('roundtrip complet', async () => {
    const { equipments } = await seedBase();
    const e = await equipments.findById('e1');
    expect(e?.name).toBe('Minipelle');
    expect(e?.purchaseValue.cents).toBe(1500000);
    expect(e?.accessMemberIds).toEqual(['m1', 'm2']);
    expect(e?.maintenanceThreshold).toBe(50);
  });

  it('liste par groupe et supprime', async () => {
    const { equipments } = await seedBase();
    expect(await equipments.findByGroupId('g1')).toHaveLength(1);
    await equipments.delete('e1');
    expect(await equipments.findByGroupId('g1')).toHaveLength(0);
  });
});

describe('SQLite — réservations', () => {
  it('roundtrip et requêtes par équipement(s)', async () => {
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
    expect(await repo.findByEquipmentIds(['e1', 'autre'])).toHaveLength(1);
    expect(await repo.findByEquipmentIds([])).toEqual([]);
    await repo.delete('r1');
    expect(await repo.findById('r1')).toBeNull();
  });
});

describe('SQLite — relevés d\'usage', () => {
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
  it('roundtrip d\'une dépense avec répartition custom', async () => {
    await seedBase();
    const repo = new SqliteExpenseRepository(db);
    await repo.save(
      Expense.create({
        id: 'x1',
        groupId: 'g1',
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
    expect(await repo.findByGroupId('g1')).toHaveLength(1);
    await repo.delete('x1');
    expect(await repo.findById('x1')).toBeNull();
  });

  it('roundtrip d\'une répartition au prorata', async () => {
    await seedBase();
    const repo = new SqliteExpenseRepository(db);
    await repo.save(
      Expense.create({
        id: 'x2',
        groupId: 'g1',
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

  it('roundtrip d\'un remboursement', async () => {
    await seedBase();
    const repo = new SqliteReimbursementRepository(db);
    await repo.save(
      Reimbursement.create({
        id: 'rb1',
        groupId: 'g1',
        fromMemberId: 'm2',
        toMemberId: 'm1',
        amount: Money.fromCents(500),
        date: new Date('2026-07-02T00:00:00Z'),
        notes: 'virement',
      }),
    );
    const list = await repo.findByGroupId('g1');
    expect(list).toHaveLength(1);
    expect(list[0]?.amount.cents).toBe(500);
    expect(list[0]?.notes).toBe('virement');
  });
});
