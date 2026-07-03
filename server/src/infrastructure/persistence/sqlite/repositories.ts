import type { SqliteDb } from './database.js';
import { Member } from '../../../domain/member/member.js';
import { Equipment } from '../../../domain/equipment/equipment.js';
import type { MeterUnit } from '../../../domain/equipment/equipment.js';
import { Reservation } from '../../../domain/reservation/reservation.js';
import { UsageRecord } from '../../../domain/usage/usage-record.js';
import { Expense } from '../../../domain/expense/expense.js';
import type { ExpenseCategory, SplitRule } from '../../../domain/expense/expense.js';
import { Reimbursement } from '../../../domain/expense/reimbursement.js';
import { Money } from '../../../domain/shared/money.js';
import { TimeRange } from '../../../domain/shared/time-range.js';
import { MemberCredential } from '../../../domain/auth/credential.js';
import type { Session } from '../../../domain/auth/session.js';
import type {
  CredentialRepository,
  EquipmentRepository,
  ExpenseRepository,
  MemberRepository,
  ReimbursementRepository,
  ReservationRepository,
  SessionRepository,
  UsageRecordRepository,
} from '../../../application/ports.js';

export class SqliteMemberRepository implements MemberRepository {
  constructor(private readonly db: SqliteDb) {}

  async findById(id: string): Promise<Member | null> {
    const row = this.db.prepare('SELECT * FROM members WHERE id = ?').get(id) as
      { id: string; name: string; email: string | null } | undefined;
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
      .prepare(
        'INSERT INTO members (id, name, email) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email',
      )
      .run(member.id, member.name, member.email);
  }
}

interface CredentialRow {
  member_id: string;
  password_hash: string | null;
  invite_code: string | null;
}

export class SqliteCredentialRepository implements CredentialRepository {
  constructor(private readonly db: SqliteDb) {}

  private toEntity(row: CredentialRow): MemberCredential {
    return MemberCredential.create({
      memberId: row.member_id,
      passwordHash: row.password_hash,
      inviteCode: row.invite_code,
    });
  }

  async findByMemberId(memberId: string): Promise<MemberCredential | null> {
    const row = this.db.prepare('SELECT * FROM member_credentials WHERE member_id = ?').get(memberId) as
      CredentialRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  async findByInviteCode(code: string): Promise<MemberCredential | null> {
    const row = this.db.prepare('SELECT * FROM member_credentials WHERE invite_code = ?').get(code) as
      CredentialRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  async count(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM member_credentials').get() as { count: number };
    return row.count;
  }

  async save(credential: MemberCredential): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO member_credentials (member_id, password_hash, invite_code) VALUES (?, ?, ?)
         ON CONFLICT(member_id) DO UPDATE SET password_hash = excluded.password_hash, invite_code = excluded.invite_code`,
      )
      .run(credential.memberId, credential.passwordHash, credential.inviteCode);
  }
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: SqliteDb) {}

  async findByTokenHash(tokenHash: string): Promise<Session | null> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as
      { token_hash: string; member_id: string; expires_at: string } | undefined;
    return row ? { tokenHash: row.token_hash, memberId: row.member_id, expiresAt: new Date(row.expires_at) } : null;
  }

  async save(session: Session): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, member_id, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(token_hash) DO UPDATE SET expires_at = excluded.expires_at`,
      )
      .run(session.tokenHash, session.memberId, session.expiresAt.toISOString());
  }

  async delete(tokenHash: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  async deleteExpired(now: Date): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString());
  }
}

interface EquipmentRow {
  id: string;
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
    const circle = this.db
      .prepare('SELECT member_id FROM equipment_members WHERE equipment_id = ? ORDER BY position')
      .all(row.id) as { member_id: string }[];
    return Equipment.create({
      id: row.id,
      name: row.name,
      category: row.category,
      acquisitionDate: new Date(row.acquisition_date),
      purchaseValue: Money.fromCents(row.purchase_value_cents),
      meterUnit: row.meter_unit as MeterUnit,
      memberIds: circle.map((a) => a.member_id),
      maintenanceThreshold: row.maintenance_threshold,
    });
  }

  async findById(id: string): Promise<Equipment | null> {
    const row = this.db.prepare('SELECT * FROM equipments WHERE id = ?').get(id) as EquipmentRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  async findAll(): Promise<Equipment[]> {
    const rows = this.db.prepare('SELECT * FROM equipments ORDER BY name').all() as EquipmentRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async save(equipment: Equipment): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO equipments (id, name, category, acquisition_date, purchase_value_cents, meter_unit, maintenance_threshold)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, category = excluded.category, acquisition_date = excluded.acquisition_date,
             purchase_value_cents = excluded.purchase_value_cents, meter_unit = excluded.meter_unit,
             maintenance_threshold = excluded.maintenance_threshold`,
        )
        .run(
          equipment.id,
          equipment.name,
          equipment.category,
          equipment.acquisitionDate.toISOString(),
          equipment.purchaseValue.cents,
          equipment.meterUnit,
          equipment.maintenanceThreshold,
        );
      this.db.prepare('DELETE FROM equipment_members WHERE equipment_id = ?').run(equipment.id);
      const insert = this.db.prepare(
        'INSERT INTO equipment_members (equipment_id, member_id, position) VALUES (?, ?, ?)',
      );
      equipment.memberIds.forEach((memberId, i) => insert.run(equipment.id, memberId, i));
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

  async findAll(): Promise<Reservation[]> {
    const rows = this.db.prepare('SELECT * FROM reservations ORDER BY start_at').all() as ReservationRow[];
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
  equipment_id: string;
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

  async findByEquipmentId(equipmentId: string): Promise<Expense[]> {
    const rows = this.db
      .prepare('SELECT * FROM expenses WHERE equipment_id = ? ORDER BY date DESC')
      .all(equipmentId) as ExpenseRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async save(expense: Expense): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO expenses (id, equipment_id, label, amount_cents, payer_id, date, category, split_json, receipt_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        expense.id,
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
  equipment_id: string;
  from_member_id: string;
  to_member_id: string;
  amount_cents: number;
  date: string;
  notes: string | null;
}

export class SqliteReimbursementRepository implements ReimbursementRepository {
  constructor(private readonly db: SqliteDb) {}

  async findByEquipmentId(equipmentId: string): Promise<Reimbursement[]> {
    const rows = this.db
      .prepare('SELECT * FROM reimbursements WHERE equipment_id = ? ORDER BY date DESC')
      .all(equipmentId) as ReimbursementRow[];
    return rows.map((row) =>
      Reimbursement.create({
        id: row.id,
        equipmentId: row.equipment_id,
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
        `INSERT OR REPLACE INTO reimbursements (id, equipment_id, from_member_id, to_member_id, amount_cents, date, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reimbursement.id,
        reimbursement.equipmentId,
        reimbursement.fromMemberId,
        reimbursement.toMemberId,
        reimbursement.amount.cents,
        reimbursement.date.toISOString(),
        reimbursement.notes,
      );
  }
}
