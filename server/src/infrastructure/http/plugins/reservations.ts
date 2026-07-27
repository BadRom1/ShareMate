import type { FastifyPluginAsync } from 'fastify';
import type { ReservationStatus } from '../../../domain/reservation/reservation.js';
import type { RecurrenceFrequency } from '../../../domain/reservation/recurrence.js';
import type { ReservationService } from '../../../application/reservation-service.js';
import { reservationDto, reservationListDto } from '../dto.js';
import { enumOf, id, idParams, isoDate, nullableText, object } from '../schema.js';
import '../session.js'; // augmentation de type : request.authMember

export interface ReservationRoutesOptions {
  reservationService: ReservationService;
}

/** Créneau : socle commun à la réservation simple, récurrente et à la mise à jour partielle. */
const SLOT = {
  equipmentId: id,
  start: isoDate,
  end: isoDate,
  status: enumOf(['PLANNED', 'REQUIRED']),
  notes: nullableText(2000),
};

const CHANGES = { start: SLOT.start, end: SLOT.end, status: SLOT.status, notes: SLOT.notes };

export const reservationRoutes: FastifyPluginAsync<ReservationRoutesOptions> = async (app, { reservationService }) => {
  app.post<{
    Body: {
      equipmentId: string;
      start: string;
      end: string;
      status?: ReservationStatus;
      notes?: string | null;
    };
  }>(
    '/api/reservations',
    { schema: { body: object(SLOT, ['equipmentId', 'start', 'end']) } },
    async (request, reply) => {
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
    },
  );

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
  }>(
    '/api/reservations/recurring',
    {
      schema: {
        body: object({ ...SLOT, frequency: enumOf(['WEEKLY', 'BIWEEKLY', 'MONTHLY']), until: isoDate }, [
          'equipmentId',
          'start',
          'end',
          'frequency',
          'until',
        ]),
      },
    },
    async (request, reply) => {
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
    },
  );

  app.put<{
    Params: { id: string };
    Body: { start?: string; end?: string; status?: ReservationStatus; notes?: string | null };
  }>('/api/reservations/:id', { schema: { params: idParams, body: object(CHANGES) } }, async (request) => {
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

  app.delete<{ Params: { id: string } }>(
    '/api/reservations/:id',
    { schema: { params: idParams } },
    async (request, reply) => {
      await reservationService.cancel(request.params.id, request.authMember.id);
      return reply.status(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/equipments/:id/reservations',
    { schema: { params: idParams } },
    async (request) => {
      return reservationListDto(await reservationService.listByEquipment(request.params.id, request.authMember.id));
    },
  );

  app.get('/api/calendar', async (request) => {
    return reservationListDto(await reservationService.calendar(request.authMember.id));
  });
};
