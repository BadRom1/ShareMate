import type { FastifyPluginAsync } from 'fastify';
import { DomainError } from '../../../domain/shared/domain-error.js';
import type { ChecklistService } from '../../../application/checklist-service.js';
import { checklistDto, checklistItemDto, checklistSummaryDto } from '../dto.js';
import { arrayOf, flag, id, idParams, object, text } from '../schema.js';
import '../session.js'; // augmentation de type : request.authMember

/** Checklists par équipement : checklists et points de contrôle. */
export interface ChecklistRoutesOptions {
  checklistService: ChecklistService;
}

const title = text(200);
const label = text(200);

export const checklistRoutes: FastifyPluginAsync<ChecklistRoutesOptions> = async (app, { checklistService }) => {
  app.get<{ Params: { id: string } }>(
    '/api/equipments/:id/checklists',
    { schema: { params: idParams } },
    async (request) => {
      const list = await checklistService.listChecklists(request.params.id, request.authMember.id);
      return list.map(checklistSummaryDto);
    },
  );

  app.post<{ Body: { equipmentId: string; title: string; itemLabels?: string[] | null } }>(
    '/api/checklists',
    { schema: { body: object({ equipmentId: id, title, itemLabels: arrayOf(label, 100) }, ['equipmentId', 'title']) } },
    async (request, reply) => {
      const checklist = await checklistService.createChecklist({
        equipmentId: request.body.equipmentId,
        authorId: request.authMember.id,
        title: request.body.title,
        itemLabels: request.body.itemLabels ?? [],
      });
      return reply.status(201).send(checklistDto(checklist));
    },
  );

  app.put<{ Params: { id: string }; Body: { title: string } }>(
    '/api/checklists/:id',
    { schema: { params: idParams, body: object({ title }, ['title']) } },
    async (request) => {
      const checklist = await checklistService.renameChecklist(
        request.params.id,
        request.authMember.id,
        request.body.title,
      );
      return checklistDto(checklist);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/checklists/:id',
    { schema: { params: idParams } },
    async (request, reply) => {
      await checklistService.deleteChecklist(request.params.id, request.authMember.id);
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/checklists/:id/reset',
    { schema: { params: idParams } },
    async (request, reply) => {
      await checklistService.resetChecklist(request.params.id, request.authMember.id);
      return reply.status(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/checklists/:id/items',
    { schema: { params: idParams } },
    async (request) => {
      const list = await checklistService.listItems(request.params.id, request.authMember.id);
      return list.map(checklistItemDto);
    },
  );

  app.post<{ Body: { checklistId: string; label: string } }>(
    '/api/checklist-items',
    { schema: { body: object({ checklistId: id, label }, ['checklistId', 'label']) } },
    async (request, reply) => {
      const item = await checklistService.addItem({
        checklistId: request.body.checklistId,
        requesterId: request.authMember.id,
        label: request.body.label,
      });
      return reply.status(201).send(checklistItemDto(item));
    },
  );

  app.put<{ Params: { id: string }; Body: { label?: string; checked?: boolean } }>(
    '/api/checklist-items/:id',
    { schema: { params: idParams, body: object({ label, checked: flag }) } },
    async (request) => {
      // Deux gestes distincts sur la même ressource, avec des droits différents :
      // renommer le point (auteur de la checklist) ou le cocher/décocher (tout le cercle).
      const { label: newLabel, checked } = request.body;
      if (newLabel !== undefined) {
        return checklistItemDto(await checklistService.renameItem(request.params.id, request.authMember.id, newLabel));
      }
      if (checked !== undefined) {
        return checklistItemDto(
          await checklistService.setItemChecked(request.params.id, request.authMember.id, checked),
        );
      }
      throw new DomainError('Indiquez le libellé à modifier ou l’état de la coche.');
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/checklist-items/:id',
    { schema: { params: idParams } },
    async (request, reply) => {
      await checklistService.deleteItem(request.params.id, request.authMember.id);
      return reply.status(204).send();
    },
  );
};
