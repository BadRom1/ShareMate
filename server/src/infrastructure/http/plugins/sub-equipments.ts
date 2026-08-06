import type { FastifyPluginAsync } from 'fastify';
import { DomainError } from '../../../domain/shared/domain-error.js';
import { MAX_QUANTITY } from '../../../domain/equipment/sub-equipment.js';
import type { SubEquipmentService } from '../../../application/sub-equipment-service.js';
import { subEquipmentDto } from '../dto.js';
import { id, idParams, integer, nullableText, object, text } from '../schema.js';
import '../session.js'; // augmentation de type : request.authMember

/** Contenu du lot d'un équipement : remorque, godets, pompe à graisse, jerrican… */
export interface SubEquipmentRoutesOptions {
  subEquipmentService: SubEquipmentService;
}

const name = text(120);
const quantity = integer(1, MAX_QUANTITY);
const notes = nullableText(500);

export const subEquipmentRoutes: FastifyPluginAsync<SubEquipmentRoutesOptions> = async (
  app,
  { subEquipmentService },
) => {
  app.get<{ Params: { id: string } }>(
    '/api/equipments/:id/sub-equipments',
    { schema: { params: idParams } },
    async (request) => {
      const list = await subEquipmentService.list(request.params.id, request.authMember.id);
      return list.map(subEquipmentDto);
    },
  );

  app.post<{ Body: { equipmentId: string; name: string; quantity?: number; notes?: string | null } }>(
    '/api/sub-equipments',
    { schema: { body: object({ equipmentId: id, name, quantity, notes }, ['equipmentId', 'name']) } },
    async (request, reply) => {
      const subEquipment = await subEquipmentService.add({
        equipmentId: request.body.equipmentId,
        requesterId: request.authMember.id,
        name: request.body.name,
        quantity: request.body.quantity,
        notes: request.body.notes,
      });
      return reply.status(201).send(subEquipmentDto(subEquipment));
    },
  );

  app.put<{ Params: { id: string }; Body: { name?: string; quantity?: number; notes?: string | null } }>(
    '/api/sub-equipments/:id',
    { schema: { params: idParams, body: object({ name, quantity, notes }) } },
    async (request) => {
      const { name: newName, quantity: newQuantity, notes: newNotes } = request.body;
      // Un corps vide passerait le schéma et rendrait l'élément inchangé en 200 : le dire est plus
      // utile au client que de lui répondre « c'est fait » sans rien avoir fait.
      if (newName === undefined && newQuantity === undefined && newNotes === undefined) {
        throw new DomainError('Indiquez au moins un champ à modifier.');
      }
      const updated = await subEquipmentService.update(request.params.id, request.authMember.id, {
        ...(newName !== undefined && { name: newName }),
        ...(newQuantity !== undefined && { quantity: newQuantity }),
        ...(newNotes !== undefined && { notes: newNotes }),
      });
      return subEquipmentDto(updated);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/sub-equipments/:id',
    { schema: { params: idParams } },
    async (request, reply) => {
      await subEquipmentService.remove(request.params.id, request.authMember.id);
      return reply.status(204).send();
    },
  );
};
