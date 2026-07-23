import { beforeEach, describe, expect, it } from 'vitest';
import { DiscussionService } from './discussion-service.js';
import { DomainError, UnauthorizedError } from '../domain/shared/domain-error.js';
import type { NotifyEvent, Notifier } from './ports.js';
import { makeFixture } from './testing/fixture.js';
import { InMemoryMessageRepository, InMemoryThreadRepository } from './testing/in-memory.js';

class CapturingNotifier implements Notifier {
  events: NotifyEvent[] = [];
  async notify(event: NotifyEvent) {
    this.events.push(event);
  }
}

async function setup() {
  const fx = await makeFixture();
  const threads = new InMemoryThreadRepository();
  const messages = new InMemoryMessageRepository();
  const notifier = new CapturingNotifier();
  const service = new DiscussionService(
    threads,
    messages,
    fx.equipments,
    fx.members,
    fx.idGenerator,
    fx.clock,
    notifier,
  );
  return { service, threads, messages, notifier };
}

describe('DiscussionService', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('crée un fil (avec 1er message) et le liste avec son compteur', async () => {
    await ctx.service.createThread({ equipmentId: 'e1', authorId: 'm1', title: 'Panne', body: 'Détails' });
    const list = await ctx.service.listThreads('e1');
    expect(list).toHaveLength(1);
    expect(list[0]!.thread.title).toBe('Panne');
    expect(list[0]!.messageCount).toBe(1);
  });

  it("refuse un membre hors du cercle de l'équipement", async () => {
    await expect(ctx.service.createThread({ equipmentId: 'e1', authorId: 'm3', title: 'X' })).rejects.toThrow(
      DomainError,
    );
  });

  it('notifie le reste du cercle (sauf l’auteur) à l’ouverture et à la réponse', async () => {
    const thread = await ctx.service.createThread({ equipmentId: 'e1', authorId: 'm1', title: 'Sujet' });
    await ctx.service.postMessage({ threadId: thread.id, authorId: 'm1', body: 'Salut' });
    expect(ctx.notifier.events).toHaveLength(2);
    expect(ctx.notifier.events.every((e) => e.type === 'MESSAGE_POSTED')).toBe(true);
    expect(ctx.notifier.events.every((e) => e.recipientIds.join() === 'm2')).toBe(true);
  });

  it('édite un message (auteur uniquement)', async () => {
    const thread = await ctx.service.createThread({ equipmentId: 'e1', authorId: 'm1', title: 'Sujet' });
    const msg = await ctx.service.postMessage({ threadId: thread.id, authorId: 'm2', body: 'Avant' });
    await expect(ctx.service.editMessage(msg.id, 'm1', 'pirate')).rejects.toThrow(UnauthorizedError);
    const edited = await ctx.service.editMessage(msg.id, 'm2', 'Après');
    expect(edited.body).toBe('Après');
    expect(edited.editedAt).not.toBeNull();
  });

  it('répond à un message précis (parentId) en créant un sous-fil', async () => {
    const thread = await ctx.service.createThread({ equipmentId: 'e1', authorId: 'm1', title: 'Sujet' });
    const parent = await ctx.service.postMessage({ threadId: thread.id, authorId: 'm1', body: 'Question ?' });
    const reply = await ctx.service.postMessage({
      threadId: thread.id,
      authorId: 'm2',
      body: 'Réponse',
      parentId: parent.id,
    });
    expect(reply.parentId).toBe(parent.id);
    const all = await ctx.service.listMessages(thread.id);
    expect(all).toHaveLength(2);
  });

  it('refuse une réponse dont le parent est dans un autre fil', async () => {
    const t1 = await ctx.service.createThread({ equipmentId: 'e1', authorId: 'm1', title: 'A' });
    const t2 = await ctx.service.createThread({ equipmentId: 'e1', authorId: 'm1', title: 'B' });
    const parent = await ctx.service.postMessage({ threadId: t1.id, authorId: 'm1', body: 'ici' });
    await expect(
      ctx.service.postMessage({ threadId: t2.id, authorId: 'm1', body: 'ailleurs', parentId: parent.id }),
    ).rejects.toThrow(DomainError);
  });

  it('supprime un message et ses réponses imbriquées en cascade', async () => {
    const thread = await ctx.service.createThread({ equipmentId: 'e1', authorId: 'm1', title: 'Sujet' });
    const parent = await ctx.service.postMessage({ threadId: thread.id, authorId: 'm1', body: 'racine' });
    const reply = await ctx.service.postMessage({
      threadId: thread.id,
      authorId: 'm2',
      body: 'réponse',
      parentId: parent.id,
    });
    await ctx.service.postMessage({ threadId: thread.id, authorId: 'm1', body: 'sous-réponse', parentId: reply.id });
    await ctx.service.deleteMessage(parent.id, 'm1');
    expect(await ctx.service.listMessages(thread.id)).toHaveLength(0);
  });

  it('supprime un fil (auteur uniquement) et ses messages en cascade', async () => {
    const thread = await ctx.service.createThread({ equipmentId: 'e1', authorId: 'm1', title: 'Sujet', body: 'x' });
    await ctx.service.postMessage({ threadId: thread.id, authorId: 'm2', body: 'y' });
    await expect(ctx.service.deleteThread(thread.id, 'm2')).rejects.toThrow(UnauthorizedError);
    await ctx.service.deleteThread(thread.id, 'm1');
    expect(await ctx.service.listThreads('e1')).toHaveLength(0);
    expect(await ctx.service.listMessages(thread.id)).toHaveLength(0);
  });
});
