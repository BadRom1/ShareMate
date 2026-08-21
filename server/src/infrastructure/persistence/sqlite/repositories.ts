import type { SqliteDb } from './database.js';
import { Member } from '../../../domain/member/member.js';
import { Equipment } from '../../../domain/equipment/equipment.js';
import type { MeterUnit } from '../../../domain/equipment/equipment.js';
import { SubEquipment } from '../../../domain/equipment/sub-equipment.js';
import { Reservation } from '../../../domain/reservation/reservation.js';
import { UsageRecord } from '../../../domain/usage/usage-record.js';
import { Expense } from '../../../domain/expense/expense.js';
import type { ExpenseCategory, SplitRule } from '../../../domain/expense/expense.js';
import { Reimbursement } from '../../../domain/expense/reimbursement.js';
import { Money } from '../../../domain/shared/money.js';
import { TimeRange } from '../../../domain/shared/time-range.js';
import { MemberCredential } from '../../../domain/auth/credential.js';
import type { Session } from '../../../domain/auth/session.js';
import { Message } from '../../../domain/discussion/message.js';
import { Thread } from '../../../domain/discussion/thread.js';
import { Checklist } from '../../../domain/checklist/checklist.js';
import { ChecklistItem } from '../../../domain/checklist/checklist-item.js';
import { Document } from '../../../domain/document/document.js';
import type { DocumentCategory, DocumentContent } from '../../../domain/document/document.js';
import { Notification } from '../../../domain/notification/notification.js';
import { NotificationPreference } from '../../../domain/notification/preference.js';
import { NOTIFICATION_TYPES } from '../../../domain/notification/notification-type.js';
import type { NotificationType } from '../../../domain/notification/notification-type.js';
import { NOTIFICATION_PAGE_SIZE } from '../../../application/ports.js';
import type {
  ChecklistItemRepository,
  ChecklistRepository,
  CredentialRepository,
  DeviceToken,
  DeviceTokenRepository,
  DocumentRepository,
  EquipmentRepository,
  ExpenseRepository,
  MemberRepository,
  MessageRepository,
  ThreadRepository,
  NotificationPreferenceRepository,
  NotificationRepository,
  PushSubscriptionRepository,
  ReimbursementRepository,
  ReservationRepository,
  SessionRepository,
  SubEquipmentRepository,
  UsageRecordRepository,
  WebPushSubscription,
} from '../../../application/ports.js';

/** `IN (?, ?, …)` : better-sqlite3 ne lie pas un tableau à un seul paramètre. */
function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

interface MemberRow {
  id: string;
  name: string;
  email: string | null;
  invited_by: string | null;
}

export class SqliteMemberRepository implements MemberRepository {
  constructor(private readonly db: SqliteDb) {}

  private toEntity(row: MemberRow): Member {
    return Member.create({ id: row.id, name: row.name, email: row.email, invitedById: row.invited_by });
  }

  async findById(id: string): Promise<Member | null> {
    const row = this.db.prepare('SELECT * FROM members WHERE id = ?').get(id) as MemberRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  async findByIds(ids: readonly string[]): Promise<Member[]> {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM members WHERE id IN (${placeholders(ids.length)}) ORDER BY name`)
      .all(...ids) as MemberRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async findInvitedBy(inviterId: string): Promise<Member[]> {
    const rows = this.db
      .prepare('SELECT * FROM members WHERE invited_by = ? ORDER BY name')
      .all(inviterId) as MemberRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async findByNameOrEmail(identifier: string): Promise<Member[]> {
    // `minuscule` (déclarée à l'ouverture de la base) et non `lower` : cette dernière ne replie
    // que l'ASCII et écarterait « JOSÉ » de « josé ».
    const wanted = identifier.trim().toLowerCase();
    const rows = this.db
      .prepare('SELECT * FROM members WHERE minuscule(name) = ? OR minuscule(email) = ? ORDER BY name')
      .all(wanted, wanted) as MemberRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async save(member: Member): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO members (id, name, email, invited_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email, invited_by = excluded.invited_by`,
      )
      .run(member.id, member.name, member.email, member.invitedById);
  }
}

interface CredentialRow {
  member_id: string;
  password_hash: string | null;
  invite_code: string | null;
  invite_expires_at: string | null;
}

export class SqliteCredentialRepository implements CredentialRepository {
  constructor(private readonly db: SqliteDb) {}

  private toEntity(row: CredentialRow): MemberCredential {
    return MemberCredential.create({
      memberId: row.member_id,
      passwordHash: row.password_hash,
      inviteCode: row.invite_code,
      inviteExpiresAt: row.invite_expires_at ? new Date(row.invite_expires_at) : null,
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

  async findMemberIdsWithPassword(memberIds: readonly string[]): Promise<Set<string>> {
    if (memberIds.length === 0) return new Set();
    const rows = this.db
      .prepare(
        `SELECT member_id FROM member_credentials
         WHERE password_hash IS NOT NULL AND member_id IN (${placeholders(memberIds.length)})`,
      )
      .all(...memberIds) as { member_id: string }[];
    return new Set(rows.map((r) => r.member_id));
  }

  async count(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM member_credentials').get() as { count: number };
    return row.count;
  }

  async save(credential: MemberCredential): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO member_credentials (member_id, password_hash, invite_code, invite_expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(member_id) DO UPDATE SET password_hash = excluded.password_hash,
           invite_code = excluded.invite_code, invite_expires_at = excluded.invite_expires_at`,
      )
      .run(credential.memberId, credential.passwordHash, credential.inviteCode, this.expiry(credential));
  }

  /**
   * Insertion conditionnée à une table vide, en une seule instruction : la garde du bootstrap
   * ne peut pas être contournée par deux requêtes entrelacées.
   */
  async saveFirst(credential: MemberCredential): Promise<boolean> {
    const result = this.db
      .prepare(
        `INSERT INTO member_credentials (member_id, password_hash, invite_code, invite_expires_at)
         SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM member_credentials)`,
      )
      .run(credential.memberId, credential.passwordHash, credential.inviteCode, this.expiry(credential));
    return result.changes === 1;
  }

  private expiry(credential: MemberCredential): string | null {
    return credential.inviteExpiresAt ? credential.inviteExpiresAt.toISOString() : null;
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

  async deleteByMemberId(memberId: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE member_id = ?').run(memberId);
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

  /**
   * Cercles de plusieurs équipements en une interrogation : les charger un par un rendait le coût
   * d'une liste proportionnel au nombre d'équipements qu'elle contient.
   */
  private cercles(ids: string[]): Map<string, string[]> {
    const cercles = new Map<string, string[]>(ids.map((id) => [id, []]));
    if (ids.length === 0) {
      return cercles;
    }
    const rows = this.db
      .prepare(
        `SELECT equipment_id, member_id FROM equipment_members
         WHERE equipment_id IN (${placeholders(ids.length)}) ORDER BY equipment_id, position`,
      )
      .all(...ids) as { equipment_id: string; member_id: string }[];
    for (const row of rows) {
      cercles.get(row.equipment_id)?.push(row.member_id);
    }
    return cercles;
  }

  private toEntities(rows: EquipmentRow[]): Equipment[] {
    const cercles = this.cercles(rows.map((r) => r.id));
    return rows.map((row) =>
      Equipment.create({
        id: row.id,
        name: row.name,
        category: row.category,
        acquisitionDate: new Date(row.acquisition_date),
        purchaseValue: Money.fromCents(row.purchase_value_cents),
        meterUnit: row.meter_unit as MeterUnit,
        memberIds: cercles.get(row.id) ?? [],
        maintenanceThreshold: row.maintenance_threshold,
      }),
    );
  }

  async findById(id: string): Promise<Equipment | null> {
    const row = this.db.prepare('SELECT * FROM equipments WHERE id = ?').get(id) as EquipmentRow | undefined;
    return row ? (this.toEntities([row])[0] ?? null) : null;
  }

  async findByMemberId(memberId: string): Promise<Equipment[]> {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM equipments e
           JOIN equipment_members em ON em.equipment_id = e.id
          WHERE em.member_id = ?
          ORDER BY e.name`,
      )
      .all(memberId) as EquipmentRow[];
    return this.toEntities(rows);
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

interface SubEquipmentRow {
  id: string;
  equipment_id: string;
  name: string;
  quantity: number;
  notes: string | null;
  position: number;
}

export class SqliteSubEquipmentRepository implements SubEquipmentRepository {
  constructor(private readonly db: SqliteDb) {}

  private toEntity(row: SubEquipmentRow): SubEquipment {
    return SubEquipment.create({
      id: row.id,
      equipmentId: row.equipment_id,
      name: row.name,
      quantity: row.quantity,
      notes: row.notes,
      position: row.position,
    });
  }

  async findById(id: string): Promise<SubEquipment | null> {
    const row = this.db.prepare('SELECT * FROM sub_equipments WHERE id = ?').get(id) as SubEquipmentRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  async findByEquipmentId(equipmentId: string): Promise<SubEquipment[]> {
    const rows = this.db
      .prepare('SELECT * FROM sub_equipments WHERE equipment_id = ? ORDER BY position, id')
      .all(equipmentId) as SubEquipmentRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async save(subEquipment: SubEquipment): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sub_equipments (id, equipment_id, name, quantity, notes, position)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, quantity = excluded.quantity,
           notes = excluded.notes, position = excluded.position`,
      )
      .run(
        subEquipment.id,
        subEquipment.equipmentId,
        subEquipment.name,
        subEquipment.quantity,
        subEquipment.notes,
        subEquipment.position,
      );
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM sub_equipments WHERE id = ?').run(id);
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

  async findByEquipmentIds(equipmentIds: readonly string[]): Promise<Reservation[]> {
    if (equipmentIds.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM reservations WHERE equipment_id IN (${placeholders(equipmentIds.length)}) ORDER BY start_at`,
      )
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

  async findByEquipmentIds(equipmentIds: readonly string[]): Promise<UsageRecord[]> {
    if (equipmentIds.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM usage_records WHERE equipment_id IN (${placeholders(equipmentIds.length)}) ORDER BY recorded_at`,
      )
      .all(...equipmentIds) as UsageRow[];
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

  async findByReceiptPath(receiptPath: string): Promise<Expense[]> {
    const rows = this.db.prepare('SELECT * FROM expenses WHERE receipt_path = ?').all(receiptPath) as ExpenseRow[];
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

interface ThreadRow {
  id: string;
  equipment_id: string;
  author_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export class SqliteThreadRepository implements ThreadRepository {
  constructor(private readonly db: SqliteDb) {}

  private toEntity(row: ThreadRow): Thread {
    return Thread.create({
      id: row.id,
      equipmentId: row.equipment_id,
      authorId: row.author_id,
      title: row.title,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    });
  }

  async findById(id: string): Promise<Thread | null> {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  async findByEquipmentId(equipmentId: string): Promise<Thread[]> {
    const rows = this.db
      .prepare('SELECT * FROM threads WHERE equipment_id = ? ORDER BY updated_at DESC')
      .all(equipmentId) as ThreadRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async save(thread: Thread): Promise<void> {
    // ON CONFLICT DO UPDATE (et non INSERT OR REPLACE) : un REPLACE supprimerait puis réinsérerait
    // la ligne, déclenchant le ON DELETE CASCADE qui effacerait tous les messages du fil.
    this.db
      .prepare(
        `INSERT INTO threads (id, equipment_id, author_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
      )
      .run(
        thread.id,
        thread.equipmentId,
        thread.authorId,
        thread.title,
        thread.createdAt.toISOString(),
        thread.updatedAt.toISOString(),
      );
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(id);
  }
}

interface MessageRow {
  id: string;
  thread_id: string;
  author_id: string;
  body: string;
  created_at: string;
  edited_at: string | null;
  parent_id: string | null;
  attachment_key: string | null;
  attachment_name: string | null;
  attachment_type: string | null;
  attachment_size: number | null;
}

export class SqliteMessageRepository implements MessageRepository {
  constructor(private readonly db: SqliteDb) {}

  private toEntity(row: MessageRow): Message {
    return Message.create({
      id: row.id,
      threadId: row.thread_id,
      authorId: row.author_id,
      body: row.body,
      createdAt: new Date(row.created_at),
      editedAt: row.edited_at ? new Date(row.edited_at) : null,
      parentId: row.parent_id,
      // Les quatre colonnes vont ensemble : la clé présente, les trois autres le sont aussi.
      attachment: row.attachment_key
        ? {
            storageKey: row.attachment_key,
            fileName: row.attachment_name!,
            contentType: row.attachment_type!,
            sizeBytes: row.attachment_size!,
          }
        : null,
    });
  }

  async findById(id: string): Promise<Message | null> {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  async findByThreadId(threadId: string): Promise<Message[]> {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at')
      .all(threadId) as MessageRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async findByEquipmentId(equipmentId: string): Promise<Message[]> {
    const rows = this.db
      .prepare(
        `SELECT messages.* FROM messages
         JOIN threads ON threads.id = messages.thread_id
         WHERE threads.equipment_id = ? ORDER BY messages.created_at`,
      )
      .all(equipmentId) as MessageRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async countByThreadId(threadId: string): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?').get(threadId) as {
      count: number;
    };
    return row.count;
  }

  async save(message: Message): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO messages (id, thread_id, author_id, body, created_at, edited_at, parent_id,
           attachment_key, attachment_name, attachment_type, attachment_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET body = excluded.body, edited_at = excluded.edited_at`,
      )
      .run(
        message.id,
        message.threadId,
        message.authorId,
        message.body,
        message.createdAt.toISOString(),
        message.editedAt ? message.editedAt.toISOString() : null,
        message.parentId,
        message.attachment?.storageKey ?? null,
        message.attachment?.fileName ?? null,
        message.attachment?.contentType ?? null,
        message.attachment?.sizeBytes ?? null,
      );
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  }
}

interface ChecklistRow {
  id: string;
  equipment_id: string;
  author_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export class SqliteChecklistRepository implements ChecklistRepository {
  constructor(private readonly db: SqliteDb) {}

  private toEntity(row: ChecklistRow): Checklist {
    return Checklist.create({
      id: row.id,
      equipmentId: row.equipment_id,
      authorId: row.author_id,
      title: row.title,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    });
  }

  async findById(id: string): Promise<Checklist | null> {
    const row = this.db.prepare('SELECT * FROM checklists WHERE id = ?').get(id) as ChecklistRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  async findByEquipmentId(equipmentId: string): Promise<Checklist[]> {
    const rows = this.db
      .prepare('SELECT * FROM checklists WHERE equipment_id = ? ORDER BY updated_at DESC')
      .all(equipmentId) as ChecklistRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async save(checklist: Checklist): Promise<void> {
    // ON CONFLICT DO UPDATE (et non INSERT OR REPLACE) : un REPLACE supprimerait puis réinsérerait
    // la ligne, déclenchant le ON DELETE CASCADE qui effacerait tous les points de la checklist.
    this.db
      .prepare(
        `INSERT INTO checklists (id, equipment_id, author_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
      )
      .run(
        checklist.id,
        checklist.equipmentId,
        checklist.authorId,
        checklist.title,
        checklist.createdAt.toISOString(),
        checklist.updatedAt.toISOString(),
      );
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM checklists WHERE id = ?').run(id);
  }
}

interface ChecklistItemRow {
  id: string;
  checklist_id: string;
  label: string;
  position: number;
  checked_at: string | null;
  checked_by_id: string | null;
}

export class SqliteChecklistItemRepository implements ChecklistItemRepository {
  constructor(private readonly db: SqliteDb) {}

  private toEntity(row: ChecklistItemRow): ChecklistItem {
    return ChecklistItem.create({
      id: row.id,
      checklistId: row.checklist_id,
      label: row.label,
      position: row.position,
      checkedAt: row.checked_at ? new Date(row.checked_at) : null,
      checkedById: row.checked_by_id,
    });
  }

  async findById(id: string): Promise<ChecklistItem | null> {
    const row = this.db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(id) as ChecklistItemRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  async findByChecklistId(checklistId: string): Promise<ChecklistItem[]> {
    const rows = this.db
      .prepare('SELECT * FROM checklist_items WHERE checklist_id = ? ORDER BY position')
      .all(checklistId) as ChecklistItemRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async save(item: ChecklistItem): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO checklist_items (id, checklist_id, label, position, checked_at, checked_by_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, position = excluded.position,
           checked_at = excluded.checked_at, checked_by_id = excluded.checked_by_id`,
      )
      .run(
        item.id,
        item.checklistId,
        item.label,
        item.position,
        item.checkedAt ? item.checkedAt.toISOString() : null,
        item.checkedById,
      );
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM checklist_items WHERE id = ?').run(id);
  }
}

interface NotificationRow {
  id: string;
  recipient_id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  created_at: string;
  read_at: string | null;
}

export class SqliteNotificationRepository implements NotificationRepository {
  constructor(private readonly db: SqliteDb) {}

  private toEntity(row: NotificationRow): Notification {
    return Notification.create({
      id: row.id,
      recipientId: row.recipient_id,
      type: row.type as NotificationType,
      title: row.title,
      body: row.body,
      link: row.link,
      createdAt: new Date(row.created_at),
      readAt: row.read_at ? new Date(row.read_at) : null,
    });
  }

  async findById(id: string): Promise<Notification | null> {
    const row = this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as NotificationRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  async findByRecipient(
    recipientId: string,
    options?: { unreadOnly?: boolean; limit?: number },
  ): Promise<Notification[]> {
    const clause = options?.unreadOnly ? 'AND read_at IS NULL' : '';
    const limit = options?.limit ?? NOTIFICATION_PAGE_SIZE;
    const rows = this.db
      .prepare(`SELECT * FROM notifications WHERE recipient_id = ? ${clause} ORDER BY created_at DESC LIMIT ?`)
      .all(recipientId, limit) as NotificationRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async countUnread(recipientId: string): Promise<number> {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM notifications WHERE recipient_id = ? AND read_at IS NULL')
      .get(recipientId) as { count: number };
    return row.count;
  }

  async save(notification: Notification): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO notifications (id, recipient_id, type, title, body, link, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        notification.id,
        notification.recipientId,
        notification.type,
        notification.title,
        notification.body,
        notification.link,
        notification.createdAt.toISOString(),
        notification.readAt ? notification.readAt.toISOString() : null,
      );
  }

  async markRead(id: string): Promise<void> {
    this.db
      .prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL')
      .run(new Date().toISOString(), id);
  }

  async markAllRead(recipientId: string): Promise<void> {
    this.db
      .prepare('UPDATE notifications SET read_at = ? WHERE recipient_id = ? AND read_at IS NULL')
      .run(new Date().toISOString(), recipientId);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM notifications WHERE id = ?').run(id);
  }

  async deleteAll(recipientId: string): Promise<void> {
    this.db.prepare('DELETE FROM notifications WHERE recipient_id = ?').run(recipientId);
  }
}

interface PreferenceRow {
  member_id: string;
  type: string;
  in_app: number;
  push: number;
}

export class SqliteNotificationPreferenceRepository implements NotificationPreferenceRepository {
  constructor(private readonly db: SqliteDb) {}

  async findByMember(memberId: string): Promise<NotificationPreference[]> {
    const rows = this.db
      .prepare('SELECT * FROM notification_preferences WHERE member_id = ?')
      .all(memberId) as PreferenceRow[];
    return (
      rows
        // Un type retiré du domaine laisse ses rangées derrière lui : elles ne correspondent plus
        // à aucune préférence lisible, et `NotificationPreference.create` les rejetterait.
        .filter((r) => NOTIFICATION_TYPES.includes(r.type as NotificationType))
        .map((r) =>
          NotificationPreference.create({
            memberId: r.member_id,
            type: r.type as NotificationType,
            inApp: r.in_app === 1,
            push: r.push === 1,
          }),
        )
    );
  }

  async upsert(preference: NotificationPreference): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO notification_preferences (member_id, type, in_app, push) VALUES (?, ?, ?, ?)
         ON CONFLICT(member_id, type) DO UPDATE SET in_app = excluded.in_app, push = excluded.push`,
      )
      .run(preference.memberId, preference.type, preference.inApp ? 1 : 0, preference.push ? 1 : 0);
  }
}

export class SqlitePushSubscriptionRepository implements PushSubscriptionRepository {
  constructor(private readonly db: SqliteDb) {}

  async findByMember(memberId: string): Promise<WebPushSubscription[]> {
    const rows = this.db.prepare('SELECT * FROM push_subscriptions WHERE member_id = ?').all(memberId) as {
      endpoint: string;
      member_id: string;
      p256dh: string;
      auth: string;
    }[];
    return rows.map((r) => ({ endpoint: r.endpoint, memberId: r.member_id, p256dh: r.p256dh, auth: r.auth }));
  }

  async save(subscription: WebPushSubscription): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, member_id, p256dh, auth) VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET member_id = excluded.member_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .run(subscription.endpoint, subscription.memberId, subscription.p256dh, subscription.auth);
  }

  async deleteByEndpoint(memberId: string, endpoint: string): Promise<void> {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND member_id = ?').run(endpoint, memberId);
  }
}

export class SqliteDeviceTokenRepository implements DeviceTokenRepository {
  constructor(private readonly db: SqliteDb) {}

  async findByMember(memberId: string): Promise<DeviceToken[]> {
    const rows = this.db.prepare('SELECT * FROM device_tokens WHERE member_id = ?').all(memberId) as {
      token: string;
      member_id: string;
      platform: string;
    }[];
    return rows.map((r) => ({ token: r.token, memberId: r.member_id, platform: r.platform }));
  }

  async save(token: DeviceToken): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO device_tokens (token, member_id, platform) VALUES (?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET member_id = excluded.member_id, platform = excluded.platform`,
      )
      .run(token.token, token.memberId, token.platform);
  }

  async deleteByToken(memberId: string, token: string): Promise<void> {
    this.db.prepare('DELETE FROM device_tokens WHERE token = ? AND member_id = ?').run(token, memberId);
  }
}

interface DocumentRow {
  id: string;
  equipment_id: string;
  author_id: string;
  name: string;
  category: string;
  created_at: string;
  storage_key: string | null;
  file_name: string | null;
  content_type: string | null;
  size_bytes: number | null;
  url: string | null;
}

export class SqliteDocumentRepository implements DocumentRepository {
  constructor(private readonly db: SqliteDb) {}

  private toEntity(row: DocumentRow): Document {
    // La contrainte CHECK de la table garantit qu'exactement une des deux natures est renseignée :
    // une ligne qui porterait les deux n'a pas pu être écrite.
    const content: DocumentContent =
      row.storage_key !== null
        ? {
            type: 'FILE',
            storageKey: row.storage_key,
            fileName: row.file_name!,
            contentType: row.content_type!,
            sizeBytes: row.size_bytes!,
          }
        : { type: 'LINK', url: row.url! };
    return Document.create({
      id: row.id,
      equipmentId: row.equipment_id,
      authorId: row.author_id,
      name: row.name,
      category: row.category as DocumentCategory,
      content,
      createdAt: new Date(row.created_at),
    });
  }

  async findById(id: string): Promise<Document | null> {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  async findByEquipmentId(equipmentId: string): Promise<Document[]> {
    const rows = this.db
      .prepare('SELECT * FROM documents WHERE equipment_id = ? ORDER BY created_at DESC, id DESC')
      .all(equipmentId) as DocumentRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async findByStorageKey(storageKey: string): Promise<Document[]> {
    const rows = this.db.prepare('SELECT * FROM documents WHERE storage_key = ?').all(storageKey) as DocumentRow[];
    return rows.map((r) => this.toEntity(r));
  }

  async save(document: Document): Promise<void> {
    const file = document.content.type === 'FILE' ? document.content : null;
    this.db
      .prepare(
        `INSERT INTO documents
           (id, equipment_id, author_id, name, category, created_at, storage_key, file_name, content_type, size_bytes, url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, category = excluded.category`,
      )
      .run(
        document.id,
        document.equipmentId,
        document.authorId,
        document.name,
        document.category,
        document.createdAt.toISOString(),
        file?.storageKey ?? null,
        file?.fileName ?? null,
        file?.contentType ?? null,
        file?.sizeBytes ?? null,
        document.content.type === 'LINK' ? document.content.url : null,
      );
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  }
}
