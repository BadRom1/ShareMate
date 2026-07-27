import type { FastifyPluginAsync } from 'fastify';
import type { EquipmentService } from '../../../application/equipment-service.js';
import { equipmentDto } from '../dto.js';
import '../session.js'; // augmentation de type : request.authMember

export interface EquipmentRoutesOptions {
  equipmentService: EquipmentService;
}

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
  }>('/api/equipments', async (request, reply) => {
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

  app.get<{ Params: { id: string } }>('/api/equipments/:id', async (request) => {
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
  }>('/api/equipments/:id', async (request) => {
    return equipmentDto(await equipmentService.update(request.params.id, request.body, request.authMember.id));
  });

  app.delete<{ Params: { id: string } }>('/api/equipments/:id', async (request, reply) => {
    await equipmentService.delete(request.params.id, request.authMember.id);
    return reply.status(204).send();
  });
};
