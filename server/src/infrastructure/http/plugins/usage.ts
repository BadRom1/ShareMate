import type { FastifyPluginAsync } from 'fastify';
import type { UsageService } from '../../../application/usage-service.js';
import { usageRecordDto } from '../dto.js';
import '../session.js'; // augmentation de type : request.authMember

/** Suivi d'usage et maintenance. */
export interface UsageRoutesOptions {
  usageService: UsageService;
}

export const usageRoutes: FastifyPluginAsync<UsageRoutesOptions> = async (app, { usageService }) => {
  app.post<{
    Body: {
      equipmentId: string;
      meterReading?: number | null;
      duration?: number | null;
      fuelAddedLiters?: number | null;
      notes?: string | null;
      isMaintenance?: boolean;
    };
  }>('/api/usage', async (request, reply) => {
    const entry = await usageService.recordUsage({ ...request.body, memberId: request.authMember.id });
    return reply.status(201).send(usageRecordDto(entry.record, entry.duration));
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id/usage', async (request) => {
    const list = await usageService.historyByEquipment(request.params.id, request.authMember.id);
    return list.map((e) => usageRecordDto(e.record, e.duration));
  });

  app.get<{ Params: { id: string } }>('/api/members/:id/usage', async (request) => {
    const list = await usageService.historyByMember(request.params.id, request.authMember.id);
    return list.map((e) => usageRecordDto(e.record, e.duration));
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id/maintenance', async (request) => {
    return usageService.maintenanceStatus(request.params.id, request.authMember.id);
  });

  app.get('/api/alerts', async (request) => {
    return usageService.alerts(request.authMember.id);
  });
};
