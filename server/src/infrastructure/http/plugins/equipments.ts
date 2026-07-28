import type { FastifyPluginAsync } from 'fastify';
import type { EquipmentService } from '../../../application/equipment-service.js';
import { equipmentDto } from '../dto.js';
import { arrayOf, enumOf, id, idParams, isoDate, nullableNumber, number, object, text } from '../schema.js';
import '../session.js'; // augmentation de type : request.authMember

export interface EquipmentRoutesOptions {
  equipmentService: EquipmentService;
}

/** Champs d'un équipement : tous obligatoires à la création, tous facultatifs à la mise à jour. */
const FIELDS = {
  name: text(120),
  category: text(80),
  acquisitionDate: isoDate,
  purchaseValueEuros: number(),
  meterUnit: enumOf(['HOURS', 'KILOMETERS']),
  // Cercle borné : chaque membre ajoute une part à calculer sur chaque dépense de l'équipement.
  memberIds: arrayOf(id, 50, 1),
  maintenanceThreshold: nullableNumber(),
};

const REQUIRED = ['name', 'category', 'acquisitionDate', 'purchaseValueEuros', 'meterUnit', 'memberIds'];

export const equipmentRoutes: FastifyPluginAsync<EquipmentRoutesOptions> = async (app, { equipmentService }) => {
  app.post<{
    Body: {
      name: string;
      category: string;
      acquisitionDate: string;
      purchaseValueEuros: number;
      meterUnit: 'HOURS' | 'KILOMETERS';
      memberIds: string[];
      maintenanceThreshold?: number | null;
    };
  }>('/api/equipments', { schema: { body: object(FIELDS, REQUIRED) } }, async (request, reply) => {
    const equipment = await equipmentService.create(
      { ...request.body, maintenanceThreshold: request.body.maintenanceThreshold ?? null },
      request.authMember.id,
    );
    return reply.status(201).send(equipmentDto(equipment));
  });

  app.get('/api/equipments', async (request) => {
    const list = await equipmentService.list(request.authMember.id);
    return list.map(equipmentDto);
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id', { schema: { params: idParams } }, async (request) => {
    return equipmentDto(await equipmentService.getById(request.params.id, request.authMember.id));
  });

  app.put<{
    Params: { id: string };
    Body: Partial<{
      name: string;
      category: string;
      acquisitionDate: string;
      purchaseValueEuros: number;
      meterUnit: 'HOURS' | 'KILOMETERS';
      memberIds: string[];
      maintenanceThreshold: number | null;
    }>;
  }>('/api/equipments/:id', { schema: { params: idParams, body: object(FIELDS) } }, async (request) => {
    return equipmentDto(await equipmentService.update(request.params.id, request.body, request.authMember.id));
  });

  // Se retirer d'un cercle a sa propre route : `PUT` refuse de le faire, pour qu'on ne perde
  // jamais l'accès à un équipement et à son historique par un décochage involontaire.
  app.post<{ Params: { id: string } }>(
    '/api/equipments/:id/leave',
    { schema: { params: idParams } },
    async (request, reply) => {
      await equipmentService.leaveCircle(request.params.id, request.authMember.id);
      return reply.status(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/equipments/:id',
    { schema: { params: idParams } },
    async (request, reply) => {
      await equipmentService.delete(request.params.id, request.authMember.id);
      return reply.status(204).send();
    },
  );
};
