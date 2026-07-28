import type { FastifyPluginAsync } from 'fastify';
import type { DiscussionService } from '../../../application/discussion-service.js';
import { messageDto, threadDto, threadSummaryDto } from '../dto.js';
import { id, idParams, nullableText, object, text } from '../schema.js';
import '../session.js'; // augmentation de type : request.authMember

/** Discussions par équipement : fils et messages. */
export interface DiscussionRoutesOptions {
  discussionService: DiscussionService;
}

const title = text(200);
/** Corps d'un message : généreux mais borné — il est stocké et rediffusé à tout le cercle. */
const messageBody = text(10_000);

export const discussionRoutes: FastifyPluginAsync<DiscussionRoutesOptions> = async (app, { discussionService }) => {
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
    { schema: { params: idParams, body: object({ body: messageBody }, ['body']) } },
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
};
