import type { Member } from '../domain/member/member.js';
import type { MemberCredential } from '../domain/auth/credential.js';
import type { Session } from '../domain/auth/session.js';
import type { Equipment } from '../domain/equipment/equipment.js';
import type { Reservation } from '../domain/reservation/reservation.js';
import type { UsageRecord } from '../domain/usage/usage-record.js';
import type { Expense } from '../domain/expense/expense.js';
import type { Reimbursement } from '../domain/expense/reimbursement.js';
import type { Message } from '../domain/discussion/message.js';
import type { Thread } from '../domain/discussion/thread.js';
import type { Notification } from '../domain/notification/notification.js';
import type { NotificationPreference } from '../domain/notification/preference.js';
import type { NotificationType } from '../domain/notification/notification-type.js';

/** Ports de persistance — implémentés par la couche infrastructure. */

export interface MemberRepository {
  findById(id: string): Promise<Member | null>;
  findAll(): Promise<Member[]>;
  save(member: Member): Promise<void>;
}

export interface EquipmentRepository {
  findById(id: string): Promise<Equipment | null>;
  findAll(): Promise<Equipment[]>;
  save(equipment: Equipment): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ReservationRepository {
  findById(id: string): Promise<Reservation | null>;
  findByEquipmentId(equipmentId: string): Promise<Reservation[]>;
  findAll(): Promise<Reservation[]>;
  save(reservation: Reservation): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface UsageRecordRepository {
  findByEquipmentId(equipmentId: string): Promise<UsageRecord[]>;
  findByMemberId(memberId: string): Promise<UsageRecord[]>;
  save(record: UsageRecord): Promise<void>;
}

export interface ExpenseRepository {
  findById(id: string): Promise<Expense | null>;
  findByEquipmentId(equipmentId: string): Promise<Expense[]>;
  save(expense: Expense): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ReimbursementRepository {
  findByEquipmentId(equipmentId: string): Promise<Reimbursement[]>;
  save(reimbursement: Reimbursement): Promise<void>;
}

export interface ThreadRepository {
  findById(id: string): Promise<Thread | null>;
  /** Fils de l'équipement, triés par activité décroissante (plus récent d'abord). */
  findByEquipmentId(equipmentId: string): Promise<Thread[]>;
  save(thread: Thread): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface MessageRepository {
  findById(id: string): Promise<Message | null>;
  /** Messages d'un fil, triés du plus ancien au plus récent. */
  findByThreadId(threadId: string): Promise<Message[]>;
  countByThreadId(threadId: string): Promise<number>;
  save(message: Message): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface NotificationRepository {
  findById(id: string): Promise<Notification | null>;
  findByRecipient(recipientId: string, options?: { unreadOnly?: boolean; limit?: number }): Promise<Notification[]>;
  countUnread(recipientId: string): Promise<number>;
  save(notification: Notification): Promise<void>;
  markRead(id: string): Promise<void>;
  markAllRead(recipientId: string): Promise<void>;
}

export interface NotificationPreferenceRepository {
  findByMember(memberId: string): Promise<NotificationPreference[]>;
  upsert(preference: NotificationPreference): Promise<void>;
}

/** Abonnement Web Push (PWA) : endpoint navigateur + clés de chiffrement. */
export interface WebPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  memberId: string;
}

export interface PushSubscriptionRepository {
  findByMember(memberId: string): Promise<WebPushSubscription[]>;
  save(subscription: WebPushSubscription): Promise<void>;
  deleteByEndpoint(endpoint: string): Promise<void>;
}

/** Jeton d'appareil FCM (app native). */
export interface DeviceToken {
  token: string;
  memberId: string;
  platform: string;
}

export interface DeviceTokenRepository {
  findByMember(memberId: string): Promise<DeviceToken[]>;
  save(token: DeviceToken): Promise<void>;
  deleteByToken(token: string): Promise<void>;
}

export interface CredentialRepository {
  findByMemberId(memberId: string): Promise<MemberCredential | null>;
  findByInviteCode(code: string): Promise<MemberCredential | null>;
  count(): Promise<number>;
  save(credential: MemberCredential): Promise<void>;
}

export interface SessionRepository {
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  delete(tokenHash: string): Promise<void>;
  deleteExpired(now: Date): Promise<void>;
}

/** Ports techniques. */

export interface IdGenerator {
  next(): string;
}

export interface Clock {
  now(): Date;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export interface TokenGenerator {
  /** Jeton de session opaque remis au client (jamais stocké en clair). */
  sessionToken(): string;
  /** Code d'invitation court, transmissible hors de l'application. */
  inviteCode(): string;
  /** Empreinte non réversible d'un jeton, seule valeur persistée. */
  hash(token: string): string;
}

/** Charge utile poussée vers un appareil (Web Push ou FCM). */
export interface PushPayload {
  title: string;
  body: string;
  /** Chemin/route à ouvrir au clic (ex. `/?tab=discussions&equipment=e1`). */
  link: string | null;
}

/** Endpoint dont l'envoi a échoué de façon définitive (abonnement à purger). */
export interface FailedTarget {
  /** `endpoint` pour Web Push, `token` pour FCM. */
  id: string;
}

/**
 * Port technique d'envoi de push. Abstrait `web-push` (Web Push VAPID) et `firebase-admin` (FCM).
 * Retourne les cibles définitivement invalides pour que le service purge les abonnements morts.
 */
export interface PushSender {
  sendWebPush(subscriptions: WebPushSubscription[], payload: PushPayload): Promise<FailedTarget[]>;
  sendFcm(tokens: DeviceToken[], payload: PushPayload): Promise<FailedTarget[]>;
}

/** Événement à notifier, émis par les services producteurs. */
export interface NotifyEvent {
  type: NotificationType;
  recipientIds: string[];
  title: string;
  body: string;
  link?: string | null;
}

/**
 * Port de notification : dépendance découplée des services producteurs (forum, dépenses…).
 * Implémenté par `NotificationService`.
 */
export interface Notifier {
  notify(event: NotifyEvent): Promise<void>;
}
