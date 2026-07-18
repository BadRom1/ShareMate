import { Message } from '../domain/discussion/message.js';
import { DomainError, NotFoundError, UnauthorizedError } from '../domain/shared/domain-error.js';
import type {
  Clock,
  EquipmentRepository,
  IdGenerator,
  MemberRepository,
  MessageRepository,
  Notifier,
} from './ports.js';

export interface PostMessageInput {
  equipmentId: string;
  authorId: string;
  body: string;
}

/** Fil de discussion par équipement. */
export class DiscussionService {
  constructor(
    private readonly messages: MessageRepository,
    private readonly equipments: EquipmentRepository,
    private readonly members: MemberRepository,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly notifier?: Notifier,
  ) {}

  async post(input: PostMessageInput): Promise<Message> {
    const equipment = await this.equipments.findById(input.equipmentId);
    if (!equipment) {
      throw new NotFoundError(`Équipement introuvable : ${input.equipmentId}`);
    }
    if (!equipment.canBeUsedBy(input.authorId)) {
      throw new DomainError("Seuls les membres du cercle de l'équipement peuvent participer à sa discussion.");
    }
    const message = Message.create({
      id: this.idGenerator.next(),
      equipmentId: input.equipmentId,
      authorId: input.authorId,
      body: input.body,
      createdAt: this.clock.now(),
    });
    await this.messages.save(message);

    if (this.notifier) {
      const author = await this.members.findById(input.authorId);
      const authorName = author?.name ?? 'Un membre';
      const recipientIds = equipment.memberIds.filter((id) => id !== input.authorId);
      if (recipientIds.length > 0) {
        await this.notifier.notify({
          type: 'MESSAGE_POSTED',
          recipientIds,
          title: `💬 ${equipment.name}`,
          body: `${authorName} : ${excerpt(message.body)}`,
          link: `/?tab=discussions&equipment=${equipment.id}`,
        });
      }
    }
    return message;
  }

  async listByEquipment(equipmentId: string): Promise<Message[]> {
    return this.messages.findByEquipmentId(equipmentId);
  }

  async delete(id: string, requesterId: string): Promise<void> {
    const existing = await this.messages.findById(id);
    if (!existing) {
      throw new NotFoundError(`Message introuvable : ${id}`);
    }
    if (existing.authorId !== requesterId) {
      throw new UnauthorizedError('Seul l’auteur peut supprimer son message.');
    }
    await this.messages.delete(id);
  }
}

/** Aperçu du corps du message pour le texte de la notification. */
function excerpt(body: string, max = 120): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
