import type { FastifyPluginAsync } from 'fastify';
import type { ReservationStatus } from '../../../domain/reservation/reservation.js';
import type { RecurrenceFrequency } from '../../../domain/reservation/recurrence.js';
import type { ReservationService } from '../../../application/reservation-service.js';
import { reservationDto, reservationListDto } from '../dto.js';
import '../session.js'; // augmentation de type : request.authMember

export interface ReservationRoutesOptions {
  reservationService: ReservationService;
}

export const reservationRoutes: FastifyPluginAsync<ReservationRoutesOptions> = async (app, { reservationService }) => {
  app.post<{
    Body: {
      equipmentId: string;
      start: string;
      end: string;
      status?: ReservationStatus;
      notes?: string | null;
    };
  }>('/api/reservations', async (request, reply) => {
    const { reservation, conflicts } = await reservationService.reserve({
      ...request.body,
      memberId: request.authMember.id,
    });
    return reply.status(201).send(
      reservationDto(
        reservation,
        conflicts.map((c) => c.id),
      ),
    );
  });

  app.post<{
    Body: {
      equipmentId: string;
      start: string;
      end: string;
      status?: ReservationStatus;
      notes?: string | null;
      frequency: RecurrenceFrequency;
      until: string;
    };
  }>('/api/reservations/recurring', async (request, reply) => {
    const { frequency, until, ...input } = request.body;
    const results = await reservationService.reserveRecurring(
      { ...input, memberId: request.authMember.id },
      { frequency, until },
    );
    return reply.status(201).send(
      results.map(({ reservation, conflicts }) =>
        reservationDto(
          reservation,
          conflicts.map((c) => c.id),
        ),
      ),
    );
  });

  app.put<{
    Params: { id: string };
    Body: { start?: string; end?: string; status?: ReservationStatus; notes?: string | null };
  }>('/api/reservations/:id', async (request) => {
    const { reservation, conflicts } = await reservationService.update(
      request.params.id,
      request.body,
      request.authMember.id,
    );
    return reservationDto(
      reservation,
      conflicts.map((c) => c.id),
    );
  });

  app.delete<{ Params: { id: string } }>('/api/reservations/:id', async (request, reply) => {
    await reservationService.cancel(request.params.id, request.authMember.id);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id/reservations', async (request) => {
    return reservationListDto(await reservationService.listByEquipment(request.params.id, request.authMember.id));
  });

  app.get('/api/calendar', async (request) => {
    return reservationListDto(await reservationService.calendar(request.authMember.id));
  });
};
