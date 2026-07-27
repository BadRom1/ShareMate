import type { FastifyPluginAsync } from 'fastify';
import { DomainError } from '../../../domain/shared/domain-error.js';
import type { ChecklistService } from '../../../application/checklist-service.js';
import { checklistDto, checklistItemDto, checklistSummaryDto } from '../dto.js';
import '../session.js'; // augmentation de type : request.authMember

/** Checklists par équipement : checklists et points de contrôle. */
export interface ChecklistRoutesOptions {
  checklistService: ChecklistService;
}

export const checklistRoutes: FastifyPluginAsync<ChecklistRoutesOptions> = async (app, { checklistService }) => {
  app.get<{ Params: { id: string } }>('/api/equipments/:id/checklists', async (request) => {
    const list = await checklistService.listChecklists(request.params.id, request.authMember.id);
    return list.map(checklistSummaryDto);
  });

  app.post<{ Body: { equipmentId: string; title: string; itemLabels?: string[] | null } }>(
    '/api/checklists',
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

  app.put<{ Params: { id: string }; Body: { title: string } }>('/api/checklists/:id', async (request) => {
    const checklist = await checklistService.renameChecklist(
      request.params.id,
      request.authMember.id,
      request.body.title,
    );
    return checklistDto(checklist);
  });

  app.delete<{ Params: { id: string } }>('/api/checklists/:id', async (request, reply) => {
    await checklistService.deleteChecklist(request.params.id, request.authMember.id);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/checklists/:id/reset', async (request, reply) => {
    await checklistService.resetChecklist(request.params.id, request.authMember.id);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/checklists/:id/items', async (request) => {
    const list = await checklistService.listItems(request.params.id, request.authMember.id);
    return list.map(checklistItemDto);
  });

  app.post<{ Body: { checklistId: string; label: string } }>('/api/checklist-items', async (request, reply) => {
    const item = await checklistService.addItem({
      checklistId: request.body.checklistId,
      requesterId: request.authMember.id,
      label: request.body.label,
    });
    return reply.status(201).send(checklistItemDto(item));
  });

  app.put<{ Params: { id: string }; Body: { label?: string; checked?: boolean } }>(
    '/api/checklist-items/:id',
    async (request) => {
      // Deux gestes distincts sur la même ressource, avec des droits différents :
      // renommer le point (auteur de la checklist) ou le cocher/décocher (tout le cercle).
      const { label, checked } = request.body;
      if (label !== undefined) {
        return checklistItemDto(await checklistService.renameItem(request.params.id, request.authMember.id, label));
      }
      if (checked !== undefined) {
        return checklistItemDto(
          await checklistService.setItemChecked(request.params.id, request.authMember.id, checked),
        );
      }
      throw new DomainError('Indiquez le libellé à modifier ou l’état de la coche.');
    },
  );

  app.delete<{ Params: { id: string } }>('/api/checklist-items/:id', async (request, reply) => {
    await checklistService.deleteItem(request.params.id, request.authMember.id);
    return reply.status(204).send();
  });
};
