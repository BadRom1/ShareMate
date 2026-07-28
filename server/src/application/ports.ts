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
import type { Checklist } from '../domain/checklist/checklist.js';
import type { ChecklistItem } from '../domain/checklist/checklist-item.js';
import type { Notification } from '../domain/notification/notification.js';
import type { NotificationPreference } from '../domain/notification/preference.js';
import type { NotificationType } from '../domain/notification/notification-type.js';

/**
 * Ports de persistance — implémentés par la couche infrastructure.
 *
 * L'ordre de restitution des listes fait partie du contrat, au même titre que leur contenu :
 * ce que le port ne promet pas, la couche application ne doit pas en dépendre, et ce qu'il
 * promet doit valoir aussi bien pour l'adapter SQLite que pour son double en mémoire — sinon
 * la suite unitaire atteste d'un comportement que la production n'a pas. Le contrat est vérifié
 * pour les deux implémentations dans `infrastructure/persistence/sqlite/port-contract.test.ts`.
 *
 * Le tri par nom suit l'ordre des points de code (`<` en JavaScript, `ORDER BY` sur du texte
 * en SQLite) et non l'ordre alphabétique d'une locale : « Émile » se range donc après « Zoé ».
 */

export interface MemberRepository {
  findById(id: string): Promise<Member | null>;
  /**
   * Membres portant ces identifiants, triés par nom ; les inconnus sont simplement absents.
   * Aucune vue ne charge l'annuaire entier : le coût d'une page suit le périmètre du demandeur,
   * jamais la taille de l'instance.
   */
  findByIds(ids: readonly string[]): Promise<Member[]>;
  /** Membres créés par cet invitant, triés par nom. */
  findInvitedBy(inviterId: string): Promise<Member[]>;
  /**
   * Membres dont le nom ou l'email vaut `identifier`, à la casse près (et aux espaces de bord),
   * triés par nom. Le port doit répondre sans charger l'annuaire : une tentative de connexion ne
   * se paie pas la table entière. Renvoie une liste — rien n'impose l'unicité des noms.
   */
  findByNameOrEmail(identifier: string): Promise<Member[]>;
  save(member: Member): Promise<void>;
}

export interface EquipmentRepository {
  findById(id: string): Promise<Equipment | null>;
  /**
   * Équipements dont `memberId` fait partie du cercle, triés par nom. C'est le seul point d'entrée
   * des vues globales : le filtre appartient au port pour que le coût d'une page suive la taille du
   * cercle du demandeur, et non celle de l'instance.
   */
  findByMemberId(memberId: string): Promise<Equipment[]>;
  save(equipment: Equipment): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ReservationRepository {
  findById(id: string): Promise<Reservation | null>;
  /** Réservations de l'équipement, triées par début croissant. */
  findByEquipmentId(equipmentId: string): Promise<Reservation[]>;
  /**
   * Réservations de plusieurs équipements, en une seule interrogation (vue calendrier),
   * triées par début croissant tous équipements confondus.
   */
  findByEquipmentIds(equipmentIds: readonly string[]): Promise<Reservation[]>;
  save(reservation: Reservation): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface UsageRecordRepository {
  /** Relevés de l'équipement, du plus ancien au plus récent. */
  findByEquipmentId(equipmentId: string): Promise<UsageRecord[]>;
  /**
   * Relevés de plusieurs équipements, en une seule interrogation (durées, alertes d'entretien),
   * du plus ancien au plus récent tous équipements confondus.
   */
  findByEquipmentIds(equipmentIds: readonly string[]): Promise<UsageRecord[]>;
  /** Relevés saisis par le membre, du plus ancien au plus récent. */
  findByMemberId(memberId: string): Promise<UsageRecord[]>;
  save(record: UsageRecord): Promise<void>;
}

export interface ExpenseRepository {
  findById(id: string): Promise<Expense | null>;
  /** Dépenses de l'équipement, de la plus récente à la plus ancienne. */
  findByEquipmentId(equipmentId: string): Promise<Expense[]>;
  /**
   * Dépenses portant ce justificatif. Renvoie une liste et non une dépense : les données
   * antérieures à la règle d'unicité (voir `ExpenseService.addExpense`) peuvent en compter
   * plusieurs, et l'accès comme la purge doivent alors toutes les considérer.
   */
  findByReceiptPath(receiptPath: string): Promise<Expense[]>;
  save(expense: Expense): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ReimbursementRepository {
  /** Remboursements de l'équipement, du plus récent au plus ancien. */
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

export interface ChecklistRepository {
  findById(id: string): Promise<Checklist | null>;
  /** Checklists de l'équipement, triées par activité décroissante (plus récente d'abord). */
  findByEquipmentId(equipmentId: string): Promise<Checklist[]>;
  save(checklist: Checklist): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ChecklistItemRepository {
  findById(id: string): Promise<ChecklistItem | null>;
  /** Points de contrôle d'une checklist, triés par position croissante. */
  findByChecklistId(checklistId: string): Promise<ChecklistItem[]>;
  save(item: ChecklistItem): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Plafond du centre de notifications, faute de `limit` : la cloche pagine, la base non. */
export const NOTIFICATION_PAGE_SIZE = 100;

export interface NotificationRepository {
  findById(id: string): Promise<Notification | null>;
  /** Notifications du destinataire, de la plus récente à la plus ancienne, `NOTIFICATION_PAGE_SIZE` au plus. */
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
  /**
   * Supprime cet endpoint s'il appartient à ce membre, sans effet sinon. L'endpoint est le seul
   * identifiant d'un abonnement et il circule : sans la condition de propriété, le connaître
   * suffisait à couper les alertes push de son titulaire.
   */
  deleteByEndpoint(memberId: string, endpoint: string): Promise<void>;
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
  /** Supprime ce jeton s'il appartient à ce membre, sans effet sinon (cf. `deleteByEndpoint`). */
  deleteByToken(memberId: string, token: string): Promise<void>;
}

export interface CredentialRepository {
  findByMemberId(memberId: string): Promise<MemberCredential | null>;
  findByInviteCode(code: string): Promise<MemberCredential | null>;
  /**
   * Parmi ces membres, ceux dont le compte a déjà été ouvert. Le port répond en une interrogation :
   * l'annuaire pose la question pour tout un périmètre, pas membre par membre.
   */
  findMemberIdsWithPassword(memberIds: readonly string[]): Promise<Set<string>>;
  count(): Promise<number>;
  save(credential: MemberCredential): Promise<void>;
  /**
   * Enregistre l'accès du tout premier compte, et lui seul : renvoie `false` si un accès existait
   * déjà. L'implémentation doit être atomique — `count()` puis `save()` laisse deux bootstraps
   * concurrents créer chacun leur « premier compte ».
   */
  saveFirst(credential: MemberCredential): Promise<boolean>;
}

export interface SessionRepository {
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  delete(tokenHash: string): Promise<void>;
  /** Révocation globale : toutes les sessions du membre, sur tous ses appareils. */
  deleteByMemberId(memberId: string): Promise<void>;
  deleteExpired(now: Date): Promise<void>;
}

/**
 * Port de stockage des justificatifs. La couche application décide quand un justificatif devient
 * orphelin ; où et comment le fichier est rangé (disque local, objet distant) ne la regarde pas.
 * Elle ne manipule que le chemin public `/uploads/<uuid>.<ext>` porté par la dépense.
 */
export interface ReceiptStorage {
  /** Supprime le justificatif ; sans effet s'il a déjà disparu (purge idempotente). */
  delete(receiptPath: string): Promise<void>;
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
  /**
   * Ce hachage a-t-il été produit sous des paramètres périmés ? La connexion est le seul instant
   * où le mot de passe est en clair, donc le seul où durcir le coût sans le redemander au membre.
   */
  needsRehash(hash: string): boolean;
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

/** Geste sensible à conserver hors de la portée de ceux qu'il concerne. */
export interface AuditEntry {
  /** Geste journalisé, en `domaine.action` (ex. `equipement.cercle-modifie`). */
  action: string;
  /** Membre à l'origine du geste. */
  actorId: string;
  /** Ressource visée. */
  targetId: string;
  details?: Record<string, unknown>;
}

/**
 * Journal des gestes sensibles. Complète les notifications, qui s'adressent aux membres et que
 * ceux-ci peuvent effacer : la trace, elle, reste côté exploitant. Synchrone et sans retour —
 * un service ne doit jamais échouer, ni ralentir, parce que le journal est indisponible.
 */
export interface AuditLogger {
  record(entry: AuditEntry): void;
}
