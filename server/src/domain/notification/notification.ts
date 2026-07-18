import { DomainError } from '../shared/domain-error.js';
import type { NotificationType } from './notification-type.js';

export interface NotificationProps {
  id: string;
  recipientId: string;
  type: NotificationType;
  title: string;
  body: string;
  link?: string | null;
  createdAt: Date;
  readAt?: Date | null;
}

/** Notification in-app destinée à un membre. */
export class Notification {
  private constructor(
    readonly id: string,
    readonly recipientId: string,
    readonly type: NotificationType,
    readonly title: string,
    readonly body: string,
    readonly link: string | null,
    readonly createdAt: Date,
    readonly readAt: Date | null,
  ) {}

  static create(props: NotificationProps): Notification {
    const title = props.title.trim();
    if (title.length === 0) {
      throw new DomainError('Le titre de la notification est requis.');
    }
    return new Notification(
      props.id,
      props.recipientId,
      props.type,
      title,
      props.body,
      props.link ?? null,
      props.createdAt,
      props.readAt ?? null,
    );
  }

  get isRead(): boolean {
    return this.readAt !== null;
  }

  /** Copie marquée lue à l'instant `at` (entité immuable). No-op si déjà lue. */
  markRead(at: Date): Notification {
    if (this.readAt !== null) return this;
    return new Notification(this.id, this.recipientId, this.type, this.title, this.body, this.link, this.createdAt, at);
  }
}
