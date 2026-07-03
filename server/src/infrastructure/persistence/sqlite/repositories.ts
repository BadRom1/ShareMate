import type { SqliteDb } from './database.js';
import { Group } from '../../../domain/group/group.js';
import { Member } from '../../../domain/group/member.js';
import { Equipment } from '../../../domain/equipment/equipment.js';
import type { MeterUnit } from '../../../domain/equipment/equipment.js';
import { Reservation } from '../../../domain/reservation/reservation.js';
import { UsageRecord } from '../../../domain/usage/usage-record.js';
import { Expense } from '../../../domain/expense/expense.js';
import type { ExpenseCategory, SplitRule } from '../../../domain/expense/expense.js';
import { Reimbursement } from '../../../domain/expense/reimbursement.js';
import { Money } from '../../../domain/shared/money.js';
import { TimeRange } from '../../../domain/shared/time-range.js';
import type {
  EquipmentRepository,
  ExpenseRepository,
  GroupRepository,
  MemberRepository,
  ReimbursementRepository,
  ReservationRepository,
  UsageRecordRepository,
} from '../../../application/ports.js';

export class SqliteMemberRepository implements MemberRepository {
  constructor(private readonly db: SqliteDb) {}

  async findById(id: string): Promise<Member | null> {
    const row = this.db.prepare('SELECT * FROM members WHERE id = ?').get(id) as
      | { id: string; name: string; email: string | null }
      | undefined;
    return row ? Member.create(row) : null;
  }

  async findAll(): Promise<Member[]> {
    const rows = this.db.prepare('SELECT * FROM members ORDER BY name').all() as {
      id: string;
      name: string;
      email: string | null;
    }[];
    return rows.map((r) => Member.create(r));
  }

  async save(member: Member): Promise<void> {
    this.db
      .prepare('INSERT INTO members (id, name, email) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email')
      .run(member.id, member.name, member.email);
  }
}

export class SqliteGroupRepository implements GroupRepository {
  constructor(private readonly db: SqliteDb) {}

  private memberIdsOf(groupId: string): string[] {
    const rows = this.db
      .prepare('SELECT member_id FROM group_members WHERE group_id = ? ORDER BY position')
      .all(groupId) as { member_id: string }[];
    return rows.map((r) => r.member_id);
  }

  async findById(id: string): Promise<Group | null> {
    const row = this.db.prepare('SELECT * FROM "groups" WHERE id = ?').get(id) as
      | { id: string; name: string }
      | undefined;
    if (!row) return null;
    return Group.create({ id: row.id, name: row.name, memberIds: this.memberIdsOf(row.id) });
  }

  async findAll(): Promise<Group[]> {
    const rows = this.db.prepare('SELECT * FROM "groups" ORDER BY name').all() as { id: string; name: string }[];
    return rows.map((row) => Group.create({ id: row.id, name: row.name, memberIds: this.memberIdsOf(row.id) }));
  }

  async save(group: Group): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO "groups" (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name')
        .run(group.id, group.name);
      this.db.prepare('DELETE FROM group_members WHERE group_id = ?').run(group.id);
      const insert = this.db.prepare('INSERT INTO group_members (group_id, member_id, position) VALUES (?, ?, ?)');
      group.memberIds.forEach((memberId, i) => insert.run(group.id, memberId, i));
    });
    tx();
  }
}

interface EquipmentRow {
  id: string;
  group_id: string;
  name: string;
  category: string;
  acquisition_date: string;
  purchase_value_cents: number;
  meter_unit: string;
  maintenance_threshold: number | null;
}

export class SqliteEquipmentRepository implements EquipmentRepository {
  constructor(private readonly db: SqliteDb) {}

  private toEntity(row: EquipmentRow): Equipment {
    const access = this.db
      .prepare('SELECT member_id FROM equipment_access WHERE equipment_id = ? ORDER BY position')
      .all(row.id) as { member_id: string }[];
    return Equipment.create({
      id: row.id,
      groupId: row.group_id,
      name: row.name,
      category: row.category,
      acquisitionDate: new Date(row.acquisition_date),
      purchaseValue: Money.fromCents(row.purchase_value_cents),
      meterUnit: row.meter_unit as MeterUnit,
      accessMemberIds: access.map((a) => a.member_id),
      maintenanceThreshold: row.maintenance_threshold,
    });
  }

  async findById(id: string): Promise<Equipment | null> {
    const row = this.db.prepare('SELECT * FROM equipments WHERE id = ?').get(id) as EquipmentRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  async findByGroupId(groupId: string): Promise<Equipment[]> {
    const rows = this.db.prepare('SELECT * FROM equipments WHERE group_id = ? ORDER BY name').all(groupId) as EquipmentRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async save(equipment: Equipment): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO equipments (id, group_id, name, category, acquisition_date, purchase_value_cents, meter_unit, maintenance_threshold)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, category = excluded.category, acquisition_date = excluded.acquisition_date,
             purchase_value_cents = excluded.purchase_value_cents, meter_unit = excluded.meter_unit,
             maintenance_threshold = excluded.maintenance_threshold`,
        )
        .run(
          equipment.id,
          equipment.groupId,
          equipment.name,
          equipment.category,
          equipment.acquisitionDate.toISOString(),
          equipment.purchaseValue.cents,
          equipment.meterUnit,
          equipment.maintenanceThreshold,
        );
      this.db.prepare('DELETE FROM equipment_access WHERE equipment_id = ?').run(equipment.id);
      const insert = this.db.prepare('INSERT INTO equipment_access (equipment_id, member_id, position) VALUES (?, ?, ?)');
      equipment.accessMemberIds.forEach((memberId, i) => insert.run(equipment.id, memberId, i));
    });
    tx();
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM equipments WHERE id = ?').run(id);
  }
}

interface ReservationRow {
  id: string;
  equipment_id: string;
  member_id: string;
  start_at: string;
  end_at: string;
  status: 'PLANNED' | 'REQUIRED';
  created_at: string;
  notes: string | null;
}

export class SqliteReservationRepository implements ReservationRepository {
  constructor(private readonly db: SqliteDb) {}

  private toEntity(row: ReservationRow): Reservation {
    return Reservation.create({
      id: row.id,
      equipmentId: row.equipment_id,
      memberId: row.member_id,
      range: TimeRange.create(new Date(row.start_at), new Date(row.end_at)),
      status: row.status,
      createdAt: new Date(row.created_at),
      notes: row.notes,
    });
  }

  async findById(id: string): Promise<Reservation | null> {
    const row = this.db.prepare('SELECT * FROM reservations WHERE id = ?').get(id) as ReservationRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  async findByEquipmentId(equipmentId: string): Promise<Reservation[]> {
    const rows = this.db
      .prepare('SELECT * FROM reservations WHERE equipment_id = ? ORDER BY start_at')
      .all(equipmentId) as ReservationRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async findByEquipmentIds(equipmentIds: string[]): Promise<Reservation[]> {
    if (equipmentIds.length === 0) return [];
    const placeholders = equipmentIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM reservations WHERE equipment_id IN (${placeholders}) ORDER BY start_at`)
      .all(...equipmentIds) as ReservationRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async save(reservation: Reservation): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO reservations (id, equipment_id, member_id, start_at, end_at, status, created_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET start_at = excluded.start_at, end_at = excluded.end_at,
           status = excluded.status, notes = excluded.notes`,
      )
      .run(
        reservation.id,
        reservation.equipmentId,
        reservation.memberId,
        reservation.range.start.toISOString(),
        reservation.range.end.toISOString(),
        reservation.status,
        reservation.createdAt.toISOString(),
        reservation.notes,
      );
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM reservations WHERE id = ?').run(id);
  }
}

interface UsageRow {
  id: string;
  equipment_id: string;
  member_id: string;
  recorded_at: string;
  meter_reading: number;
  fuel_added_liters: number | null;
  notes: string | null;
  is_maintenance: number;
}

export class SqliteUsageRecordRepository implements UsageRecordRepository {
  constructor(private readonly db: SqliteDb) {}

  private toEntity(row: UsageRow): UsageRecord {
    return UsageRecord.create({
      id: row.id,
      equipmentId: row.equipment_id,
      memberId: row.member_id,
      recordedAt: new Date(row.recorded_at),
      meterReading: row.meter_reading,
      fuelAddedLiters: row.fuel_added_liters,
      notes: row.notes,
      isMaintenance: row.is_maintenance === 1,
    });
  }

  async findByEquipmentId(equipmentId: string): Promise<UsageRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM usage_records WHERE equipment_id = ? ORDER BY recorded_at')
      .all(equipmentId) as UsageRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async findByMemberId(memberId: string): Promise<UsageRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM usage_records WHERE member_id = ? ORDER BY recorded_at')
      .all(memberId) as UsageRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async save(record: UsageRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO usage_records (id, equipment_id, member_id, recorded_at, meter_reading, fuel_added_liters, notes, is_maintenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.equipmentId,
        record.memberId,
        record.recordedAt.toISOString(),
        record.meterReading,
        record.fuelAddedLiters,
        record.notes,
        record.isMaintenance ? 1 : 0,
      );
  }
}

interface ExpenseRow {
  id: string;
  group_id: string;
  equipment_id: string | null;
  label: string;
  amount_cents: number;
  payer_id: string;
  date: string;
  category: string;
  split_json: string;
  receipt_path: string | null;
}

/** Sérialisation JSON de la règle de répartition (Money → centimes). */
type SplitJson =
  | { type: 'EQUAL'; memberIds: string[] }
  | { type: 'USAGE_PRORATED'; weights: Record<string, number> }
  | { type: 'CUSTOM'; amountsCents: Record<string, number> };

function splitToJson(split: SplitRule): SplitJson {
  if (split.type === 'CUSTOM') {
    return {
      type: 'CUSTOM',
      amountsCents: Object.fromEntries(Object.entries(split.amounts).map(([k, v]) => [k, v.cents])),
    };
  }
  return split;
}

function splitFromJson(json: SplitJson): SplitRule {
  if (json.type === 'CUSTOM') {
    return {
      type: 'CUSTOM',
      amounts: Object.fromEntries(Object.entries(json.amountsCents).map(([k, v]) => [k, Money.fromCents(v)])),
    };
  }
  return json;
}

export class SqliteExpenseRepository implements ExpenseRepository {
  constructor(private readonly db: SqliteDb) {}

  private toEntity(row: ExpenseRow): Expense {
    return Expense.create({
      id: row.id,
      groupId: row.group_id,
      equipmentId: row.equipment_id,
      label: row.label,
      amount: Money.fromCents(row.amount_cents),
      payerId: row.payer_id,
      date: new Date(row.date),
      category: row.category as ExpenseCategory,
      split: splitFromJson(JSON.parse(row.split_json) as SplitJson),
      receiptPath: row.receipt_path,
    });
  }

  async findById(id: string): Promise<Expense | null> {
    const row = this.db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as ExpenseRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  async findByGroupId(groupId: string): Promise<Expense[]> {
    const rows = this.db.prepare('SELECT * FROM expenses WHERE group_id = ? ORDER BY date DESC').all(groupId) as ExpenseRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async save(expense: Expense): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO expenses (id, group_id, equipment_id, label, amount_cents, payer_id, date, category, split_json, receipt_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        expense.id,
        expense.groupId,
        expense.equipmentId,
        expense.label,
        expense.amount.cents,
        expense.payerId,
        expense.date.toISOString(),
        expense.category,
        JSON.stringify(splitToJson(expense.split)),
        expense.receiptPath,
      );
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  }
}

interface ReimbursementRow {
  id: string;
  group_id: string;
  from_member_id: string;
  to_member_id: string;
  amount_cents: number;
  date: string;
  notes: string | null;
}

export class SqliteReimbursementRepository implements ReimbursementRepository {
  constructor(private readonly db: SqliteDb) {}

  async findByGroupId(groupId: string): Promise<Reimbursement[]> {
    const rows = this.db
      .prepare('SELECT * FROM reimbursements WHERE group_id = ? ORDER BY date DESC')
      .all(groupId) as ReimbursementRow[];
    return rows.map((row) =>
      Reimbursement.create({
        id: row.id,
        groupId: row.group_id,
        fromMemberId: row.from_member_id,
        toMemberId: row.to_member_id,
        amount: Money.fromCents(row.amount_cents),
        date: new Date(row.date),
        notes: row.notes,
      }),
    );
  }

  async save(reimbursement: Reimbursement): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO reimbursements (id, group_id, from_member_id, to_member_id, amount_cents, date, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reimbursement.id,
        reimbursement.groupId,
        reimbursement.fromMemberId,
        reimbursement.toMemberId,
        reimbursement.amount.cents,
        reimbursement.date.toISOString(),
        reimbursement.notes,
      );
  }
}
