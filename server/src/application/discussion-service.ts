import { Message } from '../domain/discussion/message.js';
import type { MessageAttachment } from '../domain/discussion/message.js';
import { Thread } from '../domain/discussion/thread.js';
import { AuthorizationError, DomainError, NotFoundError } from '../domain/shared/domain-error.js';
import { equipmentForMember } from './equipment-access.js';
import { assertStorageAvailable } from './equipment-storage.js';
import type { Equipment } from '../domain/equipment/equipment.js';
import type {
  Clock,
  DocumentRepository,
  EquipmentRepository,
  IdGenerator,
  MemberRepository,
  MessageRepository,
  Notifier,
  ObjectStorage,
  ThreadRepository,
} from './ports.js';

export interface CreateThreadInput {
  equipmentId: string;
  authorId: string;
  title: string;
  /** Premier message optionnel posté à l'ouverture du fil. */
  body?: string | null;
}

export interface PostMessageInput {
  threadId: string;
  authorId: string;
  body: string;
  /** Message auquel on répond (crée un sous-fil). Absent = message racine du fil. */
  parentId?: string | null;
  /** Fichier joint, déjà déposé dans le stockage. Un message en porte au plus un. */
  attachment?: MessageAttachment | null;
}

/** Fil + nombre de messages, pour l'affichage de la liste des fils. */
export interface ThreadSummary {
  thread: Thread;
  messageCount: number;
}

/** Fils de discussion par équipement, et messages au sein d'un fil. */
export class DiscussionService {
  constructor(
    private readonly threads: ThreadRepository,
    private readonly messages: MessageRepository,
    private readonly equipments: EquipmentRepository,
    private readonly members: MemberRepository,
    // Les pièces jointes et le dossier se partagent la place d'un équipement : la mesurer
    // suppose de voir les deux.
    private readonly documents: DocumentRepository,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly notifier: Notifier,
    /** Absent, les messages n'acceptent pas de pièce jointe et il n'y a rien à purger. */
    private readonly attachments?: ObjectStorage,
  ) {}

  // --- Fils ---

  async createThread(input: CreateThreadInput): Promise<Thread> {
    const equipment = await this.getEquipmentForMember(input.equipmentId, input.authorId);
    const now = this.clock.now();
    const thread = Thread.create({
      id: this.idGenerator.next(),
      equipmentId: input.equipmentId,
      authorId: input.authorId,
      title: input.title,
      createdAt: now,
    });
    await this.threads.save(thread);

    const body = input.body?.trim();
    if (body) {
      await this.messages.save(
        Message.create({
          id: this.idGenerator.next(),
          threadId: thread.id,
          authorId: input.authorId,
          body,
          createdAt: now,
        }),
      );
    }

    await this.notifyCircle(equipment, input.authorId, {
      title: `💬 ${equipment.name}`,
      body: `${await this.authorName(input.authorId)} a ouvert le fil « ${thread.title} »`,
      thread: thread.id,
    });
    return thread;
  }

  async listThreads(equipmentId: string, requesterId: string): Promise<ThreadSummary[]> {
    await this.getEquipmentForMember(equipmentId, requesterId);
    const threads = await this.threads.findByEquipmentId(equipmentId);
    return Promise.all(
      threads.map(async (thread) => ({ thread, messageCount: await this.messages.countByThreadId(thread.id) })),
    );
  }

  async renameThread(id: string, requesterId: string, title: string): Promise<Thread> {
    const thread = await this.getThreadForMember(id, requesterId);
    this.assertAuthor(thread.authorId, requesterId, 'Seul l’auteur peut renommer ce fil.');
    const renamed = thread.rename(title, this.clock.now());
    await this.threads.save(renamed);
    return renamed;
  }

  async deleteThread(id: string, requesterId: string): Promise<void> {
    const thread = await this.getThreadForMember(id, requesterId);
    this.assertAuthor(thread.authorId, requesterId, 'Seul l’auteur peut supprimer ce fil.');
    // Supprime d'abord les messages (le cascade SQL couvre aussi, mais on reste cohérent en in-memory).
    const doomed = await this.messages.findByThreadId(id);
    for (const message of doomed) {
      await this.messages.delete(message.id);
    }
    await this.threads.delete(id);
    await this.purgeAttachments(doomed);
  }

  // --- Messages ---

  async postMessage(input: PostMessageInput): Promise<Message> {
    const thread = await this.getThread(input.threadId);
    const equipment = await this.getEquipmentForMember(thread.equipmentId, input.authorId);
    const parentId = input.parentId ?? null;
    if (parentId) {
      const parent = await this.getMessage(parentId);
      if (parent.threadId !== thread.id) {
        throw new DomainError('Le message parent appartient à un autre fil.');
      }
    }
    const now = this.clock.now();
    const message = Message.create({
      id: this.idGenerator.next(),
      threadId: thread.id,
      authorId: input.authorId,
      body: input.body,
      createdAt: now,
      parentId,
      attachment: input.attachment ?? null,
    });
    await this.messages.save(message);
    await this.threads.save(thread.touch(now));

    const author = await this.authorName(input.authorId);
    await this.notifyCircle(equipment, input.authorId, {
      title: `💬 ${equipment.name} — ${thread.title}`,
      body: parentId ? `${author} a répondu : ${excerpt(message)}` : `${author} : ${excerpt(message)}`,
      thread: thread.id,
    });
    return message;
  }

  /**
   * Autorise une pièce jointe **avant** que l'octet n'atteigne le stockage : appartenance au
   * cercle du fil, puis place restante sur l'équipement — la même que celle du dossier, puisque
   * c'est le même bucket. Refuser après coup laisserait un objet que plus aucun message ne
   * nommerait, c'est-à-dire hors de portée de la purge.
   */
  async assertCanAttach(threadId: string, requesterId: string, sizeBytes: number): Promise<void> {
    const thread = await this.getThreadForMember(threadId, requesterId);
    await assertStorageAvailable(this.documents, this.messages, thread.equipmentId, sizeBytes);
  }

  /**
   * Message demandé, une fois le demandeur reconnu dans le cercle. L'adapter HTTP s'en sert pour
   * autoriser la lecture d'une pièce jointe avant de la servir : lui seul sait où l'objet est
   * rangé, la règle d'accès reste ici.
   */
  async messageForMember(id: string, requesterId: string): Promise<Message> {
    return this.getMessageForMember(id, requesterId);
  }

  async listMessages(threadId: string, requesterId: string): Promise<Message[]> {
    await this.getThreadForMember(threadId, requesterId);
    return this.messages.findByThreadId(threadId);
  }

  async editMessage(id: string, requesterId: string, body: string): Promise<Message> {
    const message = await this.getMessageForMember(id, requesterId);
    this.assertAuthor(message.authorId, requesterId, 'Seul l’auteur peut modifier ce message.');
    const edited = message.edit(body, this.clock.now());
    await this.messages.save(edited);
    return edited;
  }

  async deleteMessage(id: string, requesterId: string): Promise<void> {
    const message = await this.getMessageForMember(id, requesterId);
    this.assertAuthor(message.authorId, requesterId, 'Seul l’auteur peut supprimer ce message.');
    // Supprime aussi les réponses (et leurs propres réponses) pour ne pas laisser de sous-fils orphelins.
    await this.deleteWithReplies(message.threadId, id);
  }

  /**
   * Retire du stockage les fichiers des messages effacés. Une clé n'appartient qu'à un message —
   * elle est produite à son dépôt et ne sort jamais du serveur — donc rien d'autre ne peut la
   * nommer : il n'y a pas de survivant à chercher avant de purger.
   */
  private async purgeAttachments(deleted: readonly Message[]): Promise<void> {
    if (!this.attachments) return;
    for (const message of deleted) {
      if (message.storageKey) await this.attachments.delete(message.storageKey);
    }
  }

  /** Supprime un message et, récursivement, tous les messages qui lui répondent. */
  private async deleteWithReplies(threadId: string, id: string): Promise<void> {
    const all = await this.messages.findByThreadId(threadId);
    const childrenOf = new Map<string, string[]>();
    for (const m of all) {
      if (m.parentId) {
        const siblings = childrenOf.get(m.parentId) ?? [];
        siblings.push(m.id);
        childrenOf.set(m.parentId, siblings);
      }
    }
    const toDelete: string[] = [];
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      toDelete.push(current);
      stack.push(...(childrenOf.get(current) ?? []));
    }
    // Supprime les descendants avant le parent pour rester cohérent.
    const doomed = new Set(toDelete);
    for (const messageId of toDelete.reverse()) {
      await this.messages.delete(messageId);
    }
    await this.purgeAttachments(all.filter((m) => doomed.has(m.id)));
  }

  // --- Helpers ---

  private async getThread(id: string): Promise<Thread> {
    const thread = await this.threads.findById(id);
    if (!thread) throw new NotFoundError(`Fil introuvable : ${id}`);
    return thread;
  }

  private async getMessage(id: string): Promise<Message> {
    const message = await this.messages.findById(id);
    if (!message) throw new NotFoundError(`Message introuvable : ${id}`);
    return message;
  }

  /**
   * Fil demandé, une fois le demandeur reconnu dans le cercle de son équipement. Le refus
   * emprunte le message d'absence du fil : hors du cercle, il n'existe pas.
   */
  private async getThreadForMember(id: string, memberId: string): Promise<Thread> {
    const thread = await this.getThread(id);
    await this.getEquipmentForMember(thread.equipmentId, memberId, `Fil introuvable : ${id}`);
    return thread;
  }

  /** Message demandé, une fois le demandeur reconnu dans le cercle du fil qui le porte. */
  private async getMessageForMember(id: string, memberId: string): Promise<Message> {
    const absent = `Message introuvable : ${id}`;
    const message = await this.messages.findById(id);
    if (!message) throw new NotFoundError(absent);
    const thread = await this.getThread(message.threadId);
    await this.getEquipmentForMember(thread.equipmentId, memberId, absent);
    return message;
  }

  private async getEquipmentForMember(equipmentId: string, memberId: string, absent?: string): Promise<Equipment> {
    return equipmentForMember(this.equipments, equipmentId, memberId, absent);
  }

  /**
   * Geste réservé à l'auteur. Le demandeur est dans le cercle et voit la ressource : le refus
   * est assumé (403), pas masqué, et surtout pas un 401 qui le déconnecterait.
   */
  private assertAuthor(authorId: string, requesterId: string, message: string): void {
    if (authorId !== requesterId) throw new AuthorizationError(message);
  }

  private async authorName(memberId: string): Promise<string> {
    return (await this.members.findById(memberId))?.name ?? 'Un membre';
  }

  private async notifyCircle(
    equipment: Equipment,
    authorId: string,
    payload: { title: string; body: string; thread: string },
  ): Promise<void> {
    const recipientIds = equipment.memberIds.filter((id) => id !== authorId);
    if (recipientIds.length === 0) return;
    await this.notifier.notify({
      type: 'MESSAGE_POSTED',
      recipientIds,
      title: payload.title,
      body: payload.body,
      link: `/?tab=discussions&equipment=${equipment.id}&thread=${payload.thread}`,
    });
  }
}

/**
 * Aperçu du message pour le texte de la notification. Un message sans corps n'est pas vide pour
 * autant : il porte un fichier, qu'on annonce par son nom plutôt que par du silence.
 */
function excerpt(message: Message, max = 120): string {
  const oneLine = message.body.replace(/\s+/g, ' ').trim();
  const texte = oneLine.length > 0 ? oneLine : `📎 ${message.attachment?.fileName ?? 'fichier'}`;
  return texte.length > max ? `${texte.slice(0, max - 1)}…` : texte;
}
