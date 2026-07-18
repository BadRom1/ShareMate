import { beforeEach, describe, expect, it } from 'vitest';
import { DiscussionService } from './discussion-service.js';
import { DomainError, UnauthorizedError } from '../domain/shared/domain-error.js';
import type { NotifyEvent, Notifier } from './ports.js';
import { makeFixture } from './testing/fixture.js';
import { InMemoryMessageRepository } from './testing/in-memory.js';

class CapturingNotifier implements Notifier {
  events: NotifyEvent[] = [];
  async notify(event: NotifyEvent) {
    this.events.push(event);
  }
}

async function setup() {
  const fx = await makeFixture();
  const messages = new InMemoryMessageRepository();
  const notifier = new CapturingNotifier();
  const service = new DiscussionService(messages, fx.equipments, fx.members, fx.idGenerator, fx.clock, notifier);
  return { service, messages, notifier };
}

describe('DiscussionService', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('poste un message et le liste', async () => {
    await ctx.service.post({ equipmentId: 'e1', authorId: 'm1', body: 'Bonjour' });
    const list = await ctx.service.listByEquipment('e1');
    expect(list).toHaveLength(1);
    expect(list[0]!.body).toBe('Bonjour');
    expect(list[0]!.authorId).toBe('m1');
  });

  it("refuse un membre hors du cercle de l'équipement", async () => {
    await expect(ctx.service.post({ equipmentId: 'e1', authorId: 'm3', body: 'Coucou' })).rejects.toThrow(DomainError);
  });

  it('notifie le reste du cercle (sauf l’auteur)', async () => {
    await ctx.service.post({ equipmentId: 'e1', authorId: 'm1', body: 'Salut' });
    expect(ctx.notifier.events).toHaveLength(1);
    expect(ctx.notifier.events[0]!.type).toBe('MESSAGE_POSTED');
    expect(ctx.notifier.events[0]!.recipientIds).toEqual(['m2']);
  });

  it('seul l’auteur peut supprimer son message', async () => {
    const message = await ctx.service.post({ equipmentId: 'e1', authorId: 'm1', body: 'À supprimer' });
    await expect(ctx.service.delete(message.id, 'm2')).rejects.toThrow(UnauthorizedError);
    await ctx.service.delete(message.id, 'm1');
    expect(await ctx.service.listByEquipment('e1')).toHaveLength(0);
  });
});
