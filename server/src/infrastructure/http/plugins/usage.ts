import type { FastifyPluginAsync } from 'fastify';
import type { UsageService } from '../../../application/usage-service.js';
import { usageRecordDto } from '../dto.js';
import { flag, id, idParams, nullableNumber, nullableText, object } from '../schema.js';
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
  }>(
    '/api/usage',
    {
      schema: {
        body: object(
          {
            equipmentId: id,
            // Relevé OU durée : le service arbitre entre les deux, et refuse leur absence.
            meterReading: nullableNumber(),
            duration: nullableNumber(),
            fuelAddedLiters: nullableNumber(),
            notes: nullableText(2000),
            isMaintenance: flag,
          },
          ['equipmentId'],
        ),
      },
    },
    async (request, reply) => {
      const entry = await usageService.recordUsage({ ...request.body, memberId: request.authMember.id });
      return reply.status(201).send(usageRecordDto(entry.record, entry.duration));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/equipments/:id/usage',
    { schema: { params: idParams } },
    async (request) => {
      const list = await usageService.historyByEquipment(request.params.id, request.authMember.id);
      return list.map((e) => usageRecordDto(e.record, e.duration));
    },
  );

  app.get<{ Params: { id: string } }>('/api/members/:id/usage', { schema: { params: idParams } }, async (request) => {
    const list = await usageService.historyByMember(request.params.id, request.authMember.id);
    return list.map((e) => usageRecordDto(e.record, e.duration));
  });

  app.get<{ Params: { id: string } }>(
    '/api/equipments/:id/maintenance',
    { schema: { params: idParams } },
    async (request) => {
      return usageService.maintenanceStatus(request.params.id, request.authMember.id);
    },
  );

  app.get('/api/alerts', async (request) => {
    return usageService.alerts(request.authMember.id);
  });
};
