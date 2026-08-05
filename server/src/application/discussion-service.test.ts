import { beforeEach, describe, expect, it } from 'vitest';
import { DiscussionService } from './discussion-service.js';
import { AuthorizationError, DomainError, ForbiddenError } from '../domain/shared/domain-error.js';
import { makeFixture } from './testing/fixture.js';
import {
  CapturingNotifier,
  InMemoryDocumentRepository,
  InMemoryMessageRepository,
  InMemoryObjectStorage,
  InMemoryThreadRepository,
} from './testing/in-memory.js';

async function setup() {
  const fx = await makeFixture();
  const threads = new InMemoryThreadRepository();
  const messages = new InMemoryMessageRepository(threads);
  const documents = new InMemoryDocumentRepository();
  const notifier = new CapturingNotifier();
  const attachments = new InMemoryObjectStorage();
  const service = new DiscussionService(
    threads,
    messages,
    fx.equipments,
    fx.members,
    documents,
    fx.idGenerator,
    fx.clock,
    notifier,
    attachments,
  );
  return { service, threads, messages, documents, notifier, attachments };
}

describe('DiscussionService', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('crée un fil (avec 1er message) et le liste avec son compteur', async () => {
    await ctx.service.createThread({ equipmentId: 'e1', authorId: 'm1', title: 'Panne', body: 'Détails' });
    const list = await ctx.service.listThreads('e1', 'm1');
    expect(list).toHaveLength(1);
    expect(list[0]!.thread.title).toBe('Panne');
    expect(list[0]!.messageCount).toBe(1);
  });

  it("refuse un membre hors du cercle de l'équipement", async () => {
    await expect(ctx.service.createThread({ equipmentId: 'e1', authorId: 'm3', title: 'X' })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('notifie le reste du cercle (sauf l’auteur) à l’ouverture et à la réponse', async () => {
    const thread = await ctx.service.createThread({ equipmentId: 'e1', authorId: 'm1', title: 'Sujet' });
    await ctx.service.postMessage({ threadId: thread.id, authorId: 'm1', body: 'Salut' });
    expect(ctx.notifier.events).toHaveLength(2);
    expect(ctx.notifier.events.every((e) => e.type === 'MESSAGE_POSTED')).toBe(true);
    expect(ctx.notifier.events.every((e) => e.recipientIds.join() === 'm2')).toBe(true);
  });

  it('hors du cercle, ni les fils ni les messages ne sont visibles', async () => {
    const thread = await ctx.service.createThread({
      equipmentId: 'e1',
      authorId: 'm1',
      title: 'Panne',
      body: 'Détails',
    });
    await expect(ctx.service.listThreads('e1', 'm3')).rejects.toThrow(ForbiddenError);
    await expect(ctx.service.listMessages(thread.id, 'm3')).rejects.toThrow(ForbiddenError);
    expect(await ctx.service.listThreads('e1', 'm2')).toHaveLength(1);
  });

  it('édite un message (auteur uniquement)', async () => {
    const thread = await ctx.service.createThread({ equipmentId: 'e1', authorId: 'm1', title: 'Sujet' });
    const msg = await ctx.service.postMessage({ threadId: thread.id, authorId: 'm2', body: 'Avant' });
    await expect(ctx.service.editMessage(msg.id, 'm1', 'pirate')).rejects.toThrow(AuthorizationError);
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
    const all = await ctx.service.listMessages(thread.id, 'm1');
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
    expect(await ctx.service.listMessages(thread.id, 'm1')).toHaveLength(0);
  });

  it('supprime un fil (auteur uniquement) et ses messages en cascade', async () => {
    const thread = await ctx.service.createThread({ equipmentId: 'e1', authorId: 'm1', title: 'Sujet', body: 'x' });
    await ctx.service.postMessage({ threadId: thread.id, authorId: 'm2', body: 'y' });
    await expect(ctx.service.deleteThread(thread.id, 'm2')).rejects.toThrow(AuthorizationError);
    await ctx.service.deleteThread(thread.id, 'm1');
    expect(await ctx.service.listThreads('e1', 'm1')).toHaveLength(0);
    // Le fil n'existe plus : on constate la cascade directement sur le dépôt.
    expect(await ctx.messages.findByThreadId(thread.id)).toHaveLength(0);
  });
});

describe('DiscussionService — pièces jointes', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  let clés = 0;

  /** Fichier joint, dont la clé est neuve à chaque appel (comme un téléversement). */
  function fichier() {
    clés += 1;
    const attachment = {
      storageKey: `attachments/joint-${clés}.png`,
      fileName: 'panne.png',
      contentType: 'image/png',
      sizeBytes: 240_000,
    };
    ctx.attachments.add(attachment.storageKey);
    return attachment;
  }

  async function filAvecPièceJointe(body = 'Regardez ça') {
    const thread = await ctx.service.createThread({ equipmentId: 'e1', authorId: 'm1', title: 'Panne' });
    const attachment = fichier();
    const message = await ctx.service.postMessage({ threadId: thread.id, authorId: 'm1', body, attachment });
    return { thread, message, attachment };
  }

  it('joint un fichier à un message, et le relit', async () => {
    const { thread, message, attachment } = await filAvecPièceJointe();
    expect(message.attachment).toEqual(attachment);
    const [relu] = await ctx.service.listMessages(thread.id, 'm2');
    expect(relu!.attachment).toEqual(attachment);
  });

  it('accepte un message sans texte quand un fichier l’accompagne', async () => {
    const { message } = await filAvecPièceJointe('   ');
    expect(message.body).toBe('');
  });

  // Un message sans corps n'est pas vide : il porte un fichier, qu'on annonce par son nom.
  it('annonce la pièce jointe dans la notification d’un message sans texte', async () => {
    await filAvecPièceJointe('   ');
    expect(ctx.notifier.events.at(-1)?.body).toContain('panne.png');
  });

  it('purge l’objet quand le message est supprimé', async () => {
    const { message, attachment } = await filAvecPièceJointe();
    await ctx.service.deleteMessage(message.id, 'm1');
    expect(ctx.attachments.keys.has(attachment.storageKey)).toBe(false);
  });

  // Supprimer un message emporte ses réponses : leurs fichiers doivent partir avec elles.
  it('purge aussi les objets des réponses emportées', async () => {
    const { thread, message, attachment } = await filAvecPièceJointe();
    const réponse = fichier();
    await ctx.service.postMessage({
      threadId: thread.id,
      authorId: 'm2',
      body: 'Vu',
      parentId: message.id,
      attachment: réponse,
    });

    await ctx.service.deleteMessage(message.id, 'm1');

    expect(ctx.attachments.keys.has(attachment.storageKey)).toBe(false);
    expect(ctx.attachments.keys.has(réponse.storageKey)).toBe(false);
  });

  it('purge les objets de tout le fil quand le fil est supprimé', async () => {
    const { thread } = await filAvecPièceJointe();
    await ctx.service.deleteThread(thread.id, 'm1');
    expect(ctx.attachments.keys.size).toBe(0);
    expect(await ctx.service.listMessages(thread.id, 'm1').catch(() => 'absent')).toBe('absent');
  });

  it('garde la pièce jointe à l’édition du corps', async () => {
    const { message, attachment } = await filAvecPièceJointe();
    const édité = await ctx.service.editMessage(message.id, 'm1', 'Texte corrigé');
    expect(édité.attachment).toEqual(attachment);
  });

  describe('cercle du fil', () => {
    it('refuse de joindre un fichier hors du cercle', async () => {
      const thread = await ctx.service.createThread({ equipmentId: 'e1', authorId: 'm1', title: 'Panne' });
      await expect(ctx.service.assertCanAttach(thread.id, 'm3', 1000)).rejects.toThrow(ForbiddenError);
      await expect(ctx.service.messageForMember('nope', 'm1')).rejects.toThrow(/introuvable/);
    });

    it('refuse la lecture d’une pièce jointe hors du cercle', async () => {
      const { message } = await filAvecPièceJointe();
      await expect(ctx.service.messageForMember(message.id, 'm3')).rejects.toThrow(ForbiddenError);
      // Le refus porte le message de l'absence : détenir un identifiant ne doit rien apprendre.
      await expect(ctx.service.messageForMember(message.id, 'm3')).rejects.toThrow(
        `Message introuvable : ${message.id}`,
      );
    });
  });

  it('sans stockage configuré, la suppression reste possible', async () => {
    const fx = await makeFixture();
    const threads = new InMemoryThreadRepository();
    const messages = new InMemoryMessageRepository(threads);
    const sansStockage = new DiscussionService(
      threads,
      messages,
      fx.equipments,
      fx.members,
      new InMemoryDocumentRepository(),
      fx.idGenerator,
      fx.clock,
      new CapturingNotifier(),
    );
    const thread = await sansStockage.createThread({ equipmentId: 'e1', authorId: 'm1', title: 'Panne' });
    const message = await sansStockage.postMessage({ threadId: thread.id, authorId: 'm1', body: 'Bonjour' });
    await expect(sansStockage.deleteMessage(message.id, 'm1')).resolves.toBeUndefined();
  });
});
