import type { FastifyPluginAsync } from 'fastify';
import type { UsageService } from '../../../application/usage-service.js';
import { usageRecordDto } from '../dto.js';
import { flag, id, idParams, number, nullableId, nullableNumber, nullableText, object } from '../schema.js';
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
      startReading?: number | null;
      gapMemberId?: string | null;
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
            startReading: nullableNumber(),
            gapMemberId: nullableId,
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
      return reply.status(201).send({
        ...usageRecordDto(entry.record, entry.duration),
        // Le segment mis au jour par cette saisie, pour que le front l'annonce à celui qui vient
        // de le déclarer — sans le lui attribuer.
        gap: entry.gap ? usageRecordDto(entry.gap.record, entry.gap.duration) : null,
      });
    },
  );

  app.put<{
    Params: { id: string };
    Body: {
      meterReading?: number;
      startReading?: number | null;
      memberId?: string | null;
      fuelAddedLiters?: number | null;
      notes?: string | null;
      isMaintenance?: boolean;
    };
  }>(
    '/api/usage/:id',
    {
      schema: {
        params: idParams,
        // Correction partielle : tout champ absent garde sa valeur, `memberId` réattribue le relevé.
        body: object({
          meterReading: number(),
          startReading: nullableNumber(),
          memberId: nullableId,
          fuelAddedLiters: nullableNumber(),
          notes: nullableText(2000),
          isMaintenance: flag,
        }),
      },
    },
    async (request) => {
      const entry = await usageService.updateUsage(request.params.id, request.body, request.authMember.id);
      return usageRecordDto(entry.record, entry.duration);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/usage/:id', { schema: { params: idParams } }, async (request, reply) => {
    await usageService.deleteUsage(request.params.id, request.authMember.id);
    return reply.status(204).send();
  });

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
