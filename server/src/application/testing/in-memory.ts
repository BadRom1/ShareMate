import type {
  AuditEntry,
  AuditLogger,
  ChecklistItemRepository,
  ChecklistRepository,
  Clock,
  CredentialRepository,
  DeviceToken,
  DeviceTokenRepository,
  DocumentRepository,
  EquipmentRepository,
  ExpenseRepository,
  IdGenerator,
  MemberRepository,
  MessageRepository,
  ThreadRepository,
  NotificationPreferenceRepository,
  NotificationRepository,
  Notifier,
  NotifyEvent,
  ObjectStorage,
  PasswordHasher,
  PushSender,
  PushSubscriptionRepository,
  ReceiptStorage,
  ReimbursementRepository,
  ReservationRepository,
  SessionRepository,
  SubEquipmentRepository,
  TokenGenerator,
  UsageRecordRepository,
  WebPushSubscription,
} from '../ports.js';
import { NOTIFICATION_PAGE_SIZE } from '../ports.js';
import type { Member } from '../../domain/member/member.js';
import type { MemberCredential } from '../../domain/auth/credential.js';
import type { Session } from '../../domain/auth/session.js';
import type { Equipment } from '../../domain/equipment/equipment.js';
import type { SubEquipment } from '../../domain/equipment/sub-equipment.js';
import type { Reservation } from '../../domain/reservation/reservation.js';
import type { UsageRecord } from '../../domain/usage/usage-record.js';
import type { Expense } from '../../domain/expense/expense.js';
import type { Reimbursement } from '../../domain/expense/reimbursement.js';
import type { Message } from '../../domain/discussion/message.js';
import type { Thread } from '../../domain/discussion/thread.js';
import type { Checklist } from '../../domain/checklist/checklist.js';
import type { ChecklistItem } from '../../domain/checklist/checklist-item.js';
import type { Document } from '../../domain/document/document.js';
import type { Notification } from '../../domain/notification/notification.js';
import type { NotificationPreference } from '../../domain/notification/preference.js';

/**
 * Adapters in-memory pour les tests (doubles des ports de persistance).
 *
 * Ces doubles n'ont d'intérêt que s'ils rendent exactement ce que rendrait l'adapter SQLite,
 * ordre des listes compris (voir la tête de `ports.js`) : une divergence ferait passer au vert
 * des services qui échoueraient en production. `port-contract.test.ts` confronte les deux.
 */

/** Ordre de `ORDER BY <texte>` en SQLite : comparaison des points de code, pas de la locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class InMemoryMemberRepository implements MemberRepository {
  private items = new Map<string, Member>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByIds(ids: readonly string[]) {
    const wanted = new Set(ids);
    return [...this.items.values()].filter((m) => wanted.has(m.id)).sort((a, b) => byCodePoint(a.name, b.name));
  }
  async findInvitedBy(inviterId: string) {
    return [...this.items.values()]
      .filter((m) => m.invitedById === inviterId)
      .sort((a, b) => byCodePoint(a.name, b.name));
  }
  async findByNameOrEmail(identifier: string) {
    const wanted = identifier.trim().toLowerCase();
    return [...this.items.values()]
      .filter((m) => m.name.toLowerCase() === wanted || m.email?.toLowerCase() === wanted)
      .sort((a, b) => byCodePoint(a.name, b.name));
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
  async findByMemberId(memberId: string) {
    return [...this.items.values()].filter((e) => e.canBeUsedBy(memberId)).sort((a, b) => byCodePoint(a.name, b.name));
  }
  async save(equipment: Equipment) {
    this.items.set(equipment.id, equipment);
  }
  async delete(id: string) {
    this.items.delete(id);
  }
}

export class InMemorySubEquipmentRepository implements SubEquipmentRepository {
  private items = new Map<string, SubEquipment>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByEquipmentId(equipmentId: string) {
    return [...this.items.values()]
      .filter((s) => s.equipmentId === equipmentId)
      .sort((a, b) => a.position - b.position || byCodePoint(a.id, b.id));
  }
  async save(subEquipment: SubEquipment) {
    this.items.set(subEquipment.id, subEquipment);
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
    return [...this.items.values()]
      .filter((r) => r.equipmentId === equipmentId)
      .sort((a, b) => a.range.start.getTime() - b.range.start.getTime());
  }
  async findByEquipmentIds(equipmentIds: readonly string[]) {
    const wanted = new Set(equipmentIds);
    return [...this.items.values()]
      .filter((r) => wanted.has(r.equipmentId))
      .sort((a, b) => a.range.start.getTime() - b.range.start.getTime());
  }
  async save(reservation: Reservation) {
    this.items.set(reservation.id, reservation);
  }
  async delete(id: string) {
    this.items.delete(id);
  }
}

/** `ORDER BY recorded_at` : les dates sont stockées en ISO 8601 UTC, dont l'ordre est chronologique. */
function byRecordedAt(a: UsageRecord, b: UsageRecord): number {
  return a.recordedAt.getTime() - b.recordedAt.getTime();
}

export class InMemoryUsageRecordRepository implements UsageRecordRepository {
  private items = new Map<string, UsageRecord>();
  async findByEquipmentId(equipmentId: string) {
    return [...this.items.values()].filter((u) => u.equipmentId === equipmentId).sort(byRecordedAt);
  }
  async findByEquipmentIds(equipmentIds: readonly string[]) {
    const wanted = new Set(equipmentIds);
    return [...this.items.values()].filter((u) => wanted.has(u.equipmentId)).sort(byRecordedAt);
  }
  async findByMemberId(memberId: string) {
    return [...this.items.values()].filter((u) => u.memberId === memberId).sort(byRecordedAt);
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
    return [...this.items.values()]
      .filter((x) => x.equipmentId === equipmentId)
      .sort((a, b) => b.date.getTime() - a.date.getTime());
  }
  async findByReceiptPath(receiptPath: string) {
    return [...this.items.values()].filter((x) => x.receiptPath === receiptPath);
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
    return [...this.items.values()]
      .filter((r) => r.equipmentId === equipmentId)
      .sort((a, b) => b.date.getTime() - a.date.getTime());
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
  /** Fils connus, pour répondre « les messages de cet équipement » comme le ferait la jointure SQL. */
  constructor(private readonly threads?: InMemoryThreadRepository) {}
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByThreadId(threadId: string) {
    return [...this.items.values()]
      .filter((m) => m.threadId === threadId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async findByEquipmentId(equipmentId: string) {
    const threadIds = new Set((await this.threads?.findByEquipmentId(equipmentId))?.map((t) => t.id) ?? []);
    return [...this.items.values()]
      .filter((m) => threadIds.has(m.threadId))
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

export class InMemoryChecklistRepository implements ChecklistRepository {
  private items = new Map<string, Checklist>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByEquipmentId(equipmentId: string) {
    return [...this.items.values()]
      .filter((c) => c.equipmentId === equipmentId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }
  async save(checklist: Checklist) {
    this.items.set(checklist.id, checklist);
  }
  async delete(id: string) {
    this.items.delete(id);
  }
}

export class InMemoryChecklistItemRepository implements ChecklistItemRepository {
  private items = new Map<string, ChecklistItem>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByChecklistId(checklistId: string) {
    return [...this.items.values()]
      .filter((i) => i.checklistId === checklistId)
      .sort((a, b) => a.position - b.position);
  }
  async save(item: ChecklistItem) {
    this.items.set(item.id, item);
  }
  async delete(id: string) {
    this.items.delete(id);
  }
}

export class InMemoryDocumentRepository implements DocumentRepository {
  private items = new Map<string, Document>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByEquipmentId(equipmentId: string) {
    return [...this.items.values()]
      .filter((d) => d.equipmentId === equipmentId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || byCodePoint(b.id, a.id));
  }
  async findByStorageKey(storageKey: string) {
    return [...this.items.values()].filter((d) => d.storageKey === storageKey);
  }
  async save(document: Document) {
    this.items.set(document.id, document);
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
    return list.slice(0, options?.limit ?? NOTIFICATION_PAGE_SIZE);
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
  async delete(id: string) {
    this.items.delete(id);
  }
  async deleteAll(recipientId: string) {
    for (const [id, n] of this.items) {
      if (n.recipientId === recipientId) this.items.delete(id);
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
  async deleteByEndpoint(memberId: string, endpoint: string) {
    if (this.items.get(endpoint)?.memberId === memberId) {
      this.items.delete(endpoint);
    }
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
  async deleteByToken(memberId: string, token: string) {
    if (this.items.get(token)?.memberId === memberId) {
      this.items.delete(token);
    }
  }
}

/** Justificatifs sans disque : `paths` expose ce qui reste stocké. */
export class InMemoryReceiptStorage implements ReceiptStorage {
  readonly paths = new Set<string>();
  add(receiptPath: string) {
    this.paths.add(receiptPath);
  }
  async delete(receiptPath: string) {
    this.paths.delete(receiptPath);
  }
}

/** Objets de documents sans bucket : `keys` expose ce qui reste stocké. */
export class InMemoryObjectStorage implements ObjectStorage {
  readonly keys = new Set<string>();
  add(storageKey: string) {
    this.keys.add(storageKey);
  }
  async delete(storageKey: string) {
    this.keys.delete(storageKey);
  }
}

/**
 * Ne notifie personne. Le port `Notifier` est obligatoire — en production il est toujours branché
 * sur `NotificationService` — donc les tests qui n'observent pas les notifications le déclarent
 * explicitement ici plutôt que de laisser une branche « pas de notifier » dans le code de service.
 */
export class NullNotifier implements Notifier {
  async notify() {}
}

/** Enregistre les événements notifiés au lieu de les délivrer, pour les assertions de test. */
export class CapturingNotifier implements Notifier {
  events: NotifyEvent[] = [];
  async notify(event: NotifyEvent) {
    this.events.push(event);
  }
}

/** Journal en mémoire : `entries` expose ce qui a été tracé. */
export class RecordingAuditLogger implements AuditLogger {
  readonly entries: AuditEntry[] = [];
  record(entry: AuditEntry) {
    this.entries.push(entry);
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
  async findMemberIdsWithPassword(memberIds: readonly string[]) {
    return new Set(memberIds.filter((id) => this.items.get(id)?.hasPassword));
  }
  async count() {
    return this.items.size;
  }
  async save(credential: MemberCredential) {
    this.items.set(credential.memberId, credential);
  }
  async saveFirst(credential: MemberCredential) {
    if (this.items.size > 0) return false;
    this.items.set(credential.memberId, credential);
    return true;
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
  async deleteByMemberId(memberId: string) {
    for (const [key, session] of this.items) {
      if (session.memberId === memberId) this.items.delete(key);
    }
  }
  async deleteExpired(now: Date) {
    for (const [key, session] of this.items) {
      if (session.expiresAt.getTime() <= now.getTime()) this.items.delete(key);
    }
  }
}

/** Hachage réversible à l'œil nu, réservé aux tests. `ancien:` simule un coût périmé. */
export class FakePasswordHasher implements PasswordHasher {
  async hash(password: string) {
    return `plain:${password}`;
  }
  async verify(password: string, hash: string) {
    return hash === `plain:${password}` || hash === `ancien:${password}`;
  }
  needsRehash(hash: string) {
    return hash.startsWith('ancien:');
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
