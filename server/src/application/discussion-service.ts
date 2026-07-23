import { Message } from '../domain/discussion/message.js';
import { Thread } from '../domain/discussion/thread.js';
import { DomainError, NotFoundError, UnauthorizedError } from '../domain/shared/domain-error.js';
import type { Equipment } from '../domain/equipment/equipment.js';
import type {
  Clock,
  EquipmentRepository,
  IdGenerator,
  MemberRepository,
  MessageRepository,
  Notifier,
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
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly notifier?: Notifier,
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

  async listThreads(equipmentId: string): Promise<ThreadSummary[]> {
    const threads = await this.threads.findByEquipmentId(equipmentId);
    return Promise.all(
      threads.map(async (thread) => ({ thread, messageCount: await this.messages.countByThreadId(thread.id) })),
    );
  }

  async renameThread(id: string, requesterId: string, title: string): Promise<Thread> {
    const thread = await this.getThread(id);
    this.assertAuthor(thread.authorId, requesterId, 'Seul l’auteur peut renommer ce fil.');
    const renamed = thread.rename(title, this.clock.now());
    await this.threads.save(renamed);
    return renamed;
  }

  async deleteThread(id: string, requesterId: string): Promise<void> {
    const thread = await this.getThread(id);
    this.assertAuthor(thread.authorId, requesterId, 'Seul l’auteur peut supprimer ce fil.');
    // Supprime d'abord les messages (le cascade SQL couvre aussi, mais on reste cohérent en in-memory).
    for (const message of await this.messages.findByThreadId(id)) {
      await this.messages.delete(message.id);
    }
    await this.threads.delete(id);
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
    });
    await this.messages.save(message);
    await this.threads.save(thread.touch(now));

    const author = await this.authorName(input.authorId);
    await this.notifyCircle(equipment, input.authorId, {
      title: `💬 ${equipment.name} — ${thread.title}`,
      body: parentId
        ? `${author} a répondu : ${excerpt(message.body)}`
        : `${author} : ${excerpt(message.body)}`,
      thread: thread.id,
    });
    return message;
  }

  async listMessages(threadId: string): Promise<Message[]> {
    return this.messages.findByThreadId(threadId);
  }

  async editMessage(id: string, requesterId: string, body: string): Promise<Message> {
    const message = await this.getMessage(id);
    this.assertAuthor(message.authorId, requesterId, 'Seul l’auteur peut modifier ce message.');
    const edited = message.edit(body, this.clock.now());
    await this.messages.save(edited);
    return edited;
  }

  async deleteMessage(id: string, requesterId: string): Promise<void> {
    const message = await this.getMessage(id);
    this.assertAuthor(message.authorId, requesterId, 'Seul l’auteur peut supprimer ce message.');
    // Supprime aussi les réponses (et leurs propres réponses) pour ne pas laisser de sous-fils orphelins.
    await this.deleteWithReplies(message.threadId, id);
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
    for (const messageId of toDelete.reverse()) {
      await this.messages.delete(messageId);
    }
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

  private async getEquipmentForMember(equipmentId: string, memberId: string): Promise<Equipment> {
    const equipment = await this.equipments.findById(equipmentId);
    if (!equipment) throw new NotFoundError(`Équipement introuvable : ${equipmentId}`);
    if (!equipment.canBeUsedBy(memberId)) {
      throw new DomainError("Seuls les membres du cercle de l'équipement peuvent participer à sa discussion.");
    }
    return equipment;
  }

  private assertAuthor(authorId: string, requesterId: string, message: string): void {
    if (authorId !== requesterId) throw new UnauthorizedError(message);
  }

  private async authorName(memberId: string): Promise<string> {
    return (await this.members.findById(memberId))?.name ?? 'Un membre';
  }

  private async notifyCircle(
    equipment: Equipment,
    authorId: string,
    payload: { title: string; body: string; thread: string },
  ): Promise<void> {
    if (!this.notifier) return;
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

/** Aperçu du corps du message pour le texte de la notification. */
function excerpt(body: string, max = 120): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
