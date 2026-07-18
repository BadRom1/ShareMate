import type {
  Clock,
  CredentialRepository,
  DeviceToken,
  DeviceTokenRepository,
  EquipmentRepository,
  ExpenseRepository,
  IdGenerator,
  MemberRepository,
  MessageRepository,
  ThreadRepository,
  NotificationPreferenceRepository,
  NotificationRepository,
  PasswordHasher,
  PushSender,
  PushSubscriptionRepository,
  ReimbursementRepository,
  ReservationRepository,
  SessionRepository,
  TokenGenerator,
  UsageRecordRepository,
  WebPushSubscription,
} from '../ports.js';
import type { Member } from '../../domain/member/member.js';
import type { MemberCredential } from '../../domain/auth/credential.js';
import type { Session } from '../../domain/auth/session.js';
import type { Equipment } from '../../domain/equipment/equipment.js';
import type { Reservation } from '../../domain/reservation/reservation.js';
import type { UsageRecord } from '../../domain/usage/usage-record.js';
import type { Expense } from '../../domain/expense/expense.js';
import type { Reimbursement } from '../../domain/expense/reimbursement.js';
import type { Message } from '../../domain/discussion/message.js';
import type { Thread } from '../../domain/discussion/thread.js';
import type { Notification } from '../../domain/notification/notification.js';
import type { NotificationPreference } from '../../domain/notification/preference.js';

/** Adapters in-memory pour les tests (doubles des ports de persistance). */

export class InMemoryMemberRepository implements MemberRepository {
  private items = new Map<string, Member>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findAll() {
    return [...this.items.values()];
  }
  async save(member: Member) {
    this.items.set(member.id, member);
  }
}

export class InMemoryEquipmentRepository implements EquipmentRepository {
  private items = new Map<string, Equipment>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findAll() {
    return [...this.items.values()];
  }
  async save(equipment: Equipment) {
    this.items.set(equipment.id, equipment);
  }
  async delete(id: string) {
    this.items.delete(id);
  }
}

export class InMemoryReservationRepository implements ReservationRepository {
  private items = new Map<string, Reservation>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByEquipmentId(equipmentId: string) {
    return [...this.items.values()].filter((r) => r.equipmentId === equipmentId);
  }
  async findAll() {
    return [...this.items.values()];
  }
  async save(reservation: Reservation) {
    this.items.set(reservation.id, reservation);
  }
  async delete(id: string) {
    this.items.delete(id);
  }
}

export class InMemoryUsageRecordRepository implements UsageRecordRepository {
  private items = new Map<string, UsageRecord>();
  async findByEquipmentId(equipmentId: string) {
    return [...this.items.values()].filter((u) => u.equipmentId === equipmentId);
  }
  async findByMemberId(memberId: string) {
    return [...this.items.values()].filter((u) => u.memberId === memberId);
  }
  async save(record: UsageRecord) {
    this.items.set(record.id, record);
  }
}

export class InMemoryExpenseRepository implements ExpenseRepository {
  private items = new Map<string, Expense>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByEquipmentId(equipmentId: string) {
    return [...this.items.values()].filter((x) => x.equipmentId === equipmentId);
  }
  async save(expense: Expense) {
    this.items.set(expense.id, expense);
  }
  async delete(id: string) {
    this.items.delete(id);
  }
}

export class InMemoryReimbursementRepository implements ReimbursementRepository {
  private items = new Map<string, Reimbursement>();
  async findByEquipmentId(equipmentId: string) {
    return [...this.items.values()].filter((r) => r.equipmentId === equipmentId);
  }
  async save(reimbursement: Reimbursement) {
    this.items.set(reimbursement.id, reimbursement);
  }
}

export class InMemoryThreadRepository implements ThreadRepository {
  private items = new Map<string, Thread>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByEquipmentId(equipmentId: string) {
    return [...this.items.values()]
      .filter((t) => t.equipmentId === equipmentId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }
  async save(thread: Thread) {
    this.items.set(thread.id, thread);
  }
  async delete(id: string) {
    this.items.delete(id);
  }
}

export class InMemoryMessageRepository implements MessageRepository {
  private items = new Map<string, Message>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByThreadId(threadId: string) {
    return [...this.items.values()]
      .filter((m) => m.threadId === threadId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async countByThreadId(threadId: string) {
    return [...this.items.values()].filter((m) => m.threadId === threadId).length;
  }
  async save(message: Message) {
    this.items.set(message.id, message);
  }
  async delete(id: string) {
    this.items.delete(id);
  }
}

export class InMemoryNotificationRepository implements NotificationRepository {
  private items = new Map<string, Notification>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByRecipient(recipientId: string, options?: { unreadOnly?: boolean; limit?: number }) {
    let list = [...this.items.values()]
      .filter((n) => n.recipientId === recipientId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    if (options?.unreadOnly) list = list.filter((n) => !n.isRead);
    return options?.limit ? list.slice(0, options.limit) : list;
  }
  async countUnread(recipientId: string) {
    return [...this.items.values()].filter((n) => n.recipientId === recipientId && !n.isRead).length;
  }
  async save(notification: Notification) {
    this.items.set(notification.id, notification);
  }
  async markRead(id: string) {
    const existing = this.items.get(id);
    if (existing) this.items.set(id, existing.markRead(new Date()));
  }
  async markAllRead(recipientId: string) {
    for (const [id, n] of this.items) {
      if (n.recipientId === recipientId && !n.isRead) this.items.set(id, n.markRead(new Date()));
    }
  }
}

export class InMemoryNotificationPreferenceRepository implements NotificationPreferenceRepository {
  private items = new Map<string, NotificationPreference>();
  private key(memberId: string, type: string) {
    return `${memberId}:${type}`;
  }
  async findByMember(memberId: string) {
    return [...this.items.values()].filter((p) => p.memberId === memberId);
  }
  async upsert(preference: NotificationPreference) {
    this.items.set(this.key(preference.memberId, preference.type), preference);
  }
}

export class InMemoryPushSubscriptionRepository implements PushSubscriptionRepository {
  private items = new Map<string, WebPushSubscription>();
  async findByMember(memberId: string) {
    return [...this.items.values()].filter((s) => s.memberId === memberId);
  }
  async save(subscription: WebPushSubscription) {
    this.items.set(subscription.endpoint, subscription);
  }
  async deleteByEndpoint(endpoint: string) {
    this.items.delete(endpoint);
  }
}

export class InMemoryDeviceTokenRepository implements DeviceTokenRepository {
  private items = new Map<string, DeviceToken>();
  async findByMember(memberId: string) {
    return [...this.items.values()].filter((t) => t.memberId === memberId);
  }
  async save(token: DeviceToken) {
    this.items.set(token.token, token);
  }
  async deleteByToken(token: string) {
    this.items.delete(token);
  }
}

/** N'envoie aucun push (tests et déploiement sans clés VAPID/FCM). */
export class NoopPushSender implements PushSender {
  async sendWebPush() {
    return [];
  }
  async sendFcm() {
    return [];
  }
}

export class InMemoryCredentialRepository implements CredentialRepository {
  private items = new Map<string, MemberCredential>();
  async findByMemberId(memberId: string) {
    return this.items.get(memberId) ?? null;
  }
  async findByInviteCode(code: string) {
    return [...this.items.values()].find((c) => c.inviteCode === code) ?? null;
  }
  async count() {
    return this.items.size;
  }
  async save(credential: MemberCredential) {
    this.items.set(credential.memberId, credential);
  }
}

export class InMemorySessionRepository implements SessionRepository {
  private items = new Map<string, Session>();
  async findByTokenHash(tokenHash: string) {
    return this.items.get(tokenHash) ?? null;
  }
  async save(session: Session) {
    this.items.set(session.tokenHash, session);
  }
  async delete(tokenHash: string) {
    this.items.delete(tokenHash);
  }
  async deleteExpired(now: Date) {
    for (const [key, session] of this.items) {
      if (session.expiresAt.getTime() <= now.getTime()) this.items.delete(key);
    }
  }
}

/** Hachage réversible à l'œil nu, réservé aux tests. */
export class FakePasswordHasher implements PasswordHasher {
  async hash(password: string) {
    return `plain:${password}`;
  }
  async verify(password: string, hash: string) {
    return hash === `plain:${password}`;
  }
}

export class SequentialTokenGenerator implements TokenGenerator {
  private sessionCounter = 0;
  private inviteCounter = 0;
  sessionToken() {
    this.sessionCounter += 1;
    return `token-${this.sessionCounter}`;
  }
  inviteCode() {
    this.inviteCounter += 1;
    return `invite-${this.inviteCounter}`;
  }
  hash(token: string) {
    return `hash(${token})`;
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;
  constructor(private readonly prefix = 'id') {}
  next() {
    this.counter += 1;
    return `${this.prefix}-${this.counter}`;
  }
}

export class FixedClock implements Clock {
  constructor(private date: Date) {}
  now() {
    return this.date;
  }
  set(date: Date) {
    this.date = date;
  }
}
