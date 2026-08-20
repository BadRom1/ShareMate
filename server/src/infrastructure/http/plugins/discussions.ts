import type { FastifyPluginAsync } from 'fastify';
import path from 'node:path';
import { MAX_STORED_FILE_BYTES } from '../../../domain/shared/stored-file.js';
import { NotFoundError } from '../../../domain/shared/domain-error.js';
import type { DiscussionService } from '../../../application/discussion-service.js';
import type { AttachmentStorage } from '../../tech/attachment-storage.js';
import { messageDto, threadDto, threadSummaryDto } from '../dto.js';
import { readUpload, requiredField } from '../multipart.js';
import { limit } from '../rate-limit.js';
import type { RateLimits } from '../rate-limit.js';
import { id, idParams, nullableText, object, text } from '../schema.js';
import '../session.js'; // augmentation de type : request.authMember

/** Discussions par équipement : fils et messages. */
export interface DiscussionRoutesOptions {
  discussionService: DiscussionService;
  /** Stockage des pièces jointes ; absent, les messages restent en texte seul. */
  storage?: AttachmentStorage;
  rateLimits: RateLimits;
}

const title = text(200);
/** Corps d'un message : généreux mais borné — il est stocké et rediffusé à tout le cercle. */
const messageBody = text(10_000);
/**
 * Corps d'une édition. Il peut être vidé, mais seulement d'un message qui porte un fichier —
 * c'est alors lui qui le rend non vide. Le schéma laisse passer la chaîne vide et le domaine
 * tranche : lui seul voit la pièce jointe, que le corps de la requête ne mentionne pas.
 */
const editedBody = text(10_000, 0);

export const discussionRoutes: FastifyPluginAsync<DiscussionRoutesOptions> = async (
  app,
  { discussionService, storage, rateLimits },
) => {
  app.get<{ Params: { id: string } }>(
    '/api/equipments/:id/threads',
    { schema: { params: idParams } },
    async (request) => {
      const list = await discussionService.listThreads(request.params.id, request.authMember.id);
      return list.map(threadSummaryDto);
    },
  );

  app.post<{ Body: { equipmentId: string; title: string; body?: string | null } }>(
    '/api/threads',
    { schema: { body: object({ equipmentId: id, title, body: nullableText(10_000) }, ['equipmentId', 'title']) } },
    async (request, reply) => {
      const thread = await discussionService.createThread({
        equipmentId: request.body.equipmentId,
        authorId: request.authMember.id,
        title: request.body.title,
        body: request.body.body ?? null,
      });
      return reply.status(201).send(threadDto(thread));
    },
  );

  app.put<{ Params: { id: string }; Body: { title: string } }>(
    '/api/threads/:id',
    { schema: { params: idParams, body: object({ title }, ['title']) } },
    async (request) => {
      const thread = await discussionService.renameThread(request.params.id, request.authMember.id, request.body.title);
      return threadDto(thread);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/threads/:id',
    { schema: { params: idParams } },
    async (request, reply) => {
      await discussionService.deleteThread(request.params.id, request.authMember.id);
      return reply.status(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/threads/:id/messages',
    { schema: { params: idParams } },
    async (request) => {
      const list = await discussionService.listMessages(request.params.id, request.authMember.id);
      return list.map(messageDto);
    },
  );

  app.post<{ Body: { threadId: string; body: string; parentId?: string | null } }>(
    '/api/messages',
    {
      schema: {
        body: object({ threadId: id, body: messageBody, parentId: { type: ['string', 'null'], maxLength: 64 } }, [
          'threadId',
          'body',
        ]),
      },
    },
    async (request, reply) => {
      const message = await discussionService.postMessage({
        threadId: request.body.threadId,
        authorId: request.authMember.id,
        body: request.body.body,
        parentId: request.body.parentId ?? null,
      });
      return reply.status(201).send(messageDto(message));
    },
  );

  app.put<{ Params: { id: string }; Body: { body: string } }>(
    '/api/messages/:id',
    { schema: { params: idParams, body: object({ body: editedBody }, ['body']) } },
    async (request) => {
      const message = await discussionService.editMessage(request.params.id, request.authMember.id, request.body.body);
      return messageDto(message);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/messages/:id',
    { schema: { params: idParams } },
    async (request, reply) => {
      await discussionService.deleteMessage(request.params.id, request.authMember.id);
      return reply.status(204).send();
    },
  );

  // Sans stockage configuré, il n'y a ni pièce jointe à écrire ni pièce jointe à servir : ces deux
  // routes n'existent pas, plutôt que d'échouer à l'exécution. Les messages restent en texte seul.
  if (!storage) return;

  /**
   * Message accompagné d'un fichier. Une seule requête plutôt qu'un téléversement suivi d'un
   * envoi : le serveur voit alors le poids et l'extension réels, et rien ne reste dans le bucket
   * si le message est refusé.
   */
  app.post(
    '/api/messages/file',
    { config: { rateLimit: limit(rateLimits.sensitive), maxFileBytes: MAX_STORED_FILE_BYTES } },
    async (request, reply) => {
      const { fields, file } = await readUpload(request, MAX_STORED_FILE_BYTES);
      if (!file) {
        return reply.status(400).send({ error: 'Aucun fichier reçu.' });
      }
      const extension = path.extname(file.filename).toLowerCase();
      if (!storage.supports(extension)) {
        return reply
          .status(400)
          .send({ error: `Format non accepté. Formats gérés : ${storage.extensions().join(', ')}.` });
      }
      const threadId = requiredField(fields, 'threadId');
      // Cercle et place disponible d'abord : refuser après l'écriture laisserait dans le bucket un
      // objet que plus aucun message ne nommerait, c'est-à-dire hors de portée de la purge.
      await discussionService.assertCanAttach(threadId, request.authMember.id, file.content.length);

      const storageKey = await storage.save(file.content, extension);
      try {
        const message = await discussionService.postMessage({
          threadId,
          authorId: request.authMember.id,
          // Le corps peut être vide : la pièce jointe suffit à faire un message.
          body: fields.body ?? '',
          parentId: fields.parentId || null,
          attachment: {
            storageKey,
            fileName: file.filename,
            // Le type est déduit de l'extension acceptée, jamais celui annoncé par le client :
            // c'est lui qui sera servi en retour, et un `text/html` déclaré s'exécuterait.
            contentType: storage.contentType(extension),
            sizeBytes: file.content.length,
          },
        });
        return reply.status(201).send(messageDto(message));
      } catch (error) {
        // L'objet vient d'être écrit et rien ne le nommera : on le retire avant de propager le refus.
        await storage.delete(storageKey);
        throw error;
      }
    },
  );

  /**
   * Contenu d'une pièce jointe. La clé de l'objet ne circule jamais : on repart de l'identifiant
   * du message, dont l'accès est décidé par le cercle de l'équipement de son fil.
   */
  app.get<{ Params: { id: string } }>(
    '/api/messages/:id/attachment',
    { schema: { params: idParams } },
    async (request, reply) => {
      const absent = `Message introuvable : ${request.params.id}`;
      const message = await discussionService.messageForMember(request.params.id, request.authMember.id);
      if (!message.attachment) {
        throw new NotFoundError(absent);
      }
      const delivery = await storage.open(message.attachment.storageKey, message.attachment.fileName);
      if (!delivery) {
        throw new NotFoundError(absent);
      }
      // Jamais de copie durable côté client : la réponse dépend de droits qui peuvent changer, et
      // l'URL signée d'une redirection expire — la rejouer depuis un cache ne donnerait qu'un refus.
      reply.header('Cache-Control', 'private, no-store');
      if (delivery.kind === 'redirect') {
        return reply.redirect(delivery.url, 302);
      }
      return reply
        .header('Content-Disposition', delivery.disposition)
        .header('Content-Length', delivery.size)
        .type(delivery.contentType)
        .send(delivery.stream);
    },
  );
};
