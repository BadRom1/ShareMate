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
import { Message } from '../../../domain/discussion/message.js';
import { Thread } from '../../../domain/discussion/thread.js';
import { Notification } from '../../../domain/notification/notification.js';
import { NotificationPreference } from '../../../domain/notification/preference.js';
import type { NotificationType } from '../../../domain/notification/notification-type.js';
import type {
  CredentialRepository,
  DeviceToken,
  DeviceTokenRepository,
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
  UsageRecordRepository,
  WebPushSubscription,
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

  async countByThreadId(threadId: string): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?').get(threadId) as {
      count: number;
    };
    return row.count;
  }

  async save(message: Message): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO messages (id, thread_id, author_id, body, created_at, edited_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET body = excluded.body, edited_at = excluded.edited_at`,
      )
      .run(
        message.id,
        message.threadId,
        message.authorId,
        message.body,
        message.createdAt.toISOString(),
        message.editedAt ? message.editedAt.toISOString() : null,
      );
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
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
    const limit = options?.limit ?? 100;
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
    return rows.map((r) =>
      NotificationPreference.create({
        memberId: r.member_id,
        type: r.type as NotificationType,
        inApp: r.in_app === 1,
        push: r.push === 1,
      }),
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

  async deleteByEndpoint(endpoint: string): Promise<void> {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
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

  async deleteByToken(token: string): Promise<void> {
    this.db.prepare('DELETE FROM device_tokens WHERE token = ?').run(token);
  }
}
