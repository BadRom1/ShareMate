import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ConflictError, DomainError, NotFoundError } from '../../domain/shared/domain-error.js';
import type { ExpenseCategory } from '../../domain/expense/expense.js';
import type { ReservationStatus } from '../../domain/reservation/reservation.js';
import type { RecurrenceFrequency } from '../../domain/reservation/recurrence.js';
import { GroupService } from '../../application/group-service.js';
import { EquipmentService } from '../../application/equipment-service.js';
import { ReservationService } from '../../application/reservation-service.js';
import { UsageService } from '../../application/usage-service.js';
import { ExpenseService } from '../../application/expense-service.js';
import type { SplitInput } from '../../application/expense-service.js';
import type {
  Clock,
  EquipmentRepository,
  ExpenseRepository,
  GroupRepository,
  IdGenerator,
  MemberRepository,
  ReimbursementRepository,
  ReservationRepository,
  UsageRecordRepository,
} from '../../application/ports.js';
import {
  equipmentDto,
  expenseDto,
  groupDto,
  memberDto,
  reimbursementDto,
  reservationDto,
  reservationListDto,
  usageRecordDto,
} from './dto.js';

export interface AppDependencies {
  groups: GroupRepository;
  members: MemberRepository;
  equipments: EquipmentRepository;
  reservations: ReservationRepository;
  usageRecords: UsageRecordRepository;
  expenses: ExpenseRepository;
  reimbursements: ReimbursementRepository;
  idGenerator: IdGenerator;
  clock: Clock;
  /** Répertoire de stockage des justificatifs (null = upload désactivé). */
  uploadsDir?: string | null;
  /** Répertoire des fichiers statiques du front (null = API seule). */
  webDistDir?: string | null;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false });

  const groupService = new GroupService(deps.groups, deps.members, deps.idGenerator);
  const equipmentService = new EquipmentService(deps.equipments, deps.groups, deps.idGenerator);
  const reservationService = new ReservationService(deps.reservations, deps.equipments, deps.idGenerator, deps.clock);
  const usageService = new UsageService(deps.usageRecords, deps.equipments, deps.idGenerator, deps.clock);
  const expenseService = new ExpenseService(
    deps.expenses,
    deps.reimbursements,
    deps.groups,
    deps.reservations,
    deps.idGenerator,
  );

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ConflictError) {
      return reply.status(409).send({ error: error.message });
    }
    if (error instanceof NotFoundError) {
      return reply.status(404).send({ error: error.message });
    }
    if (error instanceof DomainError) {
      return reply.status(400).send({ error: error.message });
    }
    const httpError = error as { validation?: unknown; statusCode?: number; message?: string };
    if (httpError.validation || (httpError.statusCode && httpError.statusCode < 500)) {
      return reply.status(httpError.statusCode ?? 400).send({ error: httpError.message ?? 'Requête invalide.' });
    }
    app.log.error(error);
    return reply.status(500).send({ error: 'Erreur interne du serveur.' });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  // --- Groupes et membres ---

  app.post<{ Body: { name: string; members: { name: string; email?: string | null }[] } }>(
    '/api/groups',
    async (request, reply) => {
      const group = await groupService.createGroup(request.body);
      return reply.status(201).send(groupDto(group));
    },
  );

  app.get('/api/groups', async () => {
    const groups = await groupService.listGroups();
    return groups.map(groupDto);
  });

  app.get<{ Params: { id: string } }>('/api/groups/:id', async (request) => {
    const group = await groupService.getGroup(request.params.id);
    const members = await groupService.listMembers(group.id);
    return { ...groupDto(group), members: members.map(memberDto) };
  });

  app.post<{ Params: { id: string }; Body: { name: string; email?: string | null } }>(
    '/api/groups/:id/members',
    async (request, reply) => {
      const member = await groupService.addMember(request.params.id, request.body);
      return reply.status(201).send(memberDto(member));
    },
  );

  // --- Équipements ---

  app.post<{
    Body: {
      groupId: string;
      name: string;
      category: string;
      acquisitionDate: string;
      purchaseValueEuros: number;
      meterUnit: 'HOURS' | 'KILOMETERS';
      accessMemberIds: string[];
      maintenanceThreshold?: number | null;
    };
  }>('/api/equipments', async (request, reply) => {
    const equipment = await equipmentService.create({
      ...request.body,
      maintenanceThreshold: request.body.maintenanceThreshold ?? null,
    });
    return reply.status(201).send(equipmentDto(equipment));
  });

  app.get<{ Params: { id: string } }>('/api/groups/:id/equipments', async (request) => {
    const list = await equipmentService.listByGroup(request.params.id);
    return list.map(equipmentDto);
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id', async (request) => {
    return equipmentDto(await equipmentService.getById(request.params.id));
  });

  app.put<{
    Params: { id: string };
    Body: Partial<{
      name: string;
      category: string;
      acquisitionDate: string;
      purchaseValueEuros: number;
      meterUnit: 'HOURS' | 'KILOMETERS';
      accessMemberIds: string[];
      maintenanceThreshold: number | null;
    }>;
  }>('/api/equipments/:id', async (request) => {
    return equipmentDto(await equipmentService.update(request.params.id, request.body));
  });

  app.delete<{ Params: { id: string } }>('/api/equipments/:id', async (request, reply) => {
    await equipmentService.delete(request.params.id);
    return reply.status(204).send();
  });

  // --- Réservations ---

  app.post<{
    Body: {
      equipmentId: string;
      memberId: string;
      start: string;
      end: string;
      status?: ReservationStatus;
      notes?: string | null;
    };
  }>('/api/reservations', async (request, reply) => {
    const { reservation, conflicts } = await reservationService.reserve(request.body);
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
      memberId: string;
      start: string;
      end: string;
      status?: ReservationStatus;
      notes?: string | null;
      frequency: RecurrenceFrequency;
      until: string;
    };
  }>('/api/reservations/recurring', async (request, reply) => {
    const { frequency, until, ...input } = request.body;
    const results = await reservationService.reserveRecurring(input, { frequency, until });
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
    const { reservation, conflicts } = await reservationService.update(request.params.id, request.body);
    return reservationDto(
      reservation,
      conflicts.map((c) => c.id),
    );
  });

  app.delete<{ Params: { id: string } }>('/api/reservations/:id', async (request, reply) => {
    await reservationService.cancel(request.params.id);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id/reservations', async (request) => {
    return reservationListDto(await reservationService.listByEquipment(request.params.id));
  });

  app.get<{ Params: { id: string } }>('/api/groups/:id/calendar', async (request) => {
    return reservationListDto(await reservationService.groupCalendar(request.params.id));
  });

  // --- Suivi d'usage et maintenance ---

  app.post<{
    Body: {
      equipmentId: string;
      memberId: string;
      meterReading: number;
      fuelAddedLiters?: number | null;
      notes?: string | null;
      isMaintenance?: boolean;
    };
  }>('/api/usage', async (request, reply) => {
    const record = await usageService.recordUsage(request.body);
    return reply.status(201).send(usageRecordDto(record));
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id/usage', async (request) => {
    const list = await usageService.historyByEquipment(request.params.id);
    return list.map(usageRecordDto);
  });

  app.get<{ Params: { id: string } }>('/api/members/:id/usage', async (request) => {
    const list = await usageService.historyByMember(request.params.id);
    return list.map(usageRecordDto);
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id/maintenance', async (request) => {
    return usageService.maintenanceStatus(request.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/groups/:id/alerts', async (request) => {
    return usageService.groupAlerts(request.params.id);
  });

  // --- Dépenses, soldes, remboursements ---

  app.post<{
    Body: {
      groupId: string;
      equipmentId?: string | null;
      label: string;
      amountEuros: number;
      payerId: string;
      date: string;
      category: ExpenseCategory;
      split: SplitInput;
      receiptPath?: string | null;
    };
  }>('/api/expenses', async (request, reply) => {
    const expense = await expenseService.addExpense(request.body);
    return reply.status(201).send(expenseDto(expense));
  });

  app.get<{ Params: { id: string } }>('/api/groups/:id/expenses', async (request) => {
    const list = await expenseService.listExpenses(request.params.id);
    return list.map(expenseDto);
  });

  app.delete<{ Params: { id: string } }>('/api/expenses/:id', async (request, reply) => {
    await expenseService.deleteExpense(request.params.id);
    return reply.status(204).send();
  });

  app.post<{
    Body: { groupId: string; fromMemberId: string; toMemberId: string; amountEuros: number; date: string; notes?: string | null };
  }>('/api/reimbursements', async (request, reply) => {
    const reimbursement = await expenseService.recordReimbursement(request.body);
    return reply.status(201).send(reimbursementDto(reimbursement));
  });

  app.get<{ Params: { id: string } }>('/api/groups/:id/reimbursements', async (request) => {
    const list = await expenseService.listReimbursements(request.params.id);
    return list.map(reimbursementDto);
  });

  app.get<{ Params: { id: string } }>('/api/groups/:id/balances', async (request) => {
    const balances = await expenseService.groupBalances(request.params.id);
    return balances.map((b) => ({ memberId: b.memberId, balanceEuros: b.balanceCents / 100 }));
  });

  app.get<{ Params: { id: string } }>('/api/groups/:id/settlement', async (request) => {
    const plan = await expenseService.settlementPlan(request.params.id);
    return plan.map((t) => ({
      fromMemberId: t.fromMemberId,
      toMemberId: t.toMemberId,
      amountEuros: t.amountCents / 100,
    }));
  });

  // --- Upload de justificatifs ---

  if (deps.uploadsDir) {
    const uploadsDir = deps.uploadsDir;
    fs.mkdirSync(uploadsDir, { recursive: true });
    app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

    const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.pdf']);
    app.post('/api/uploads/receipts', async (request, reply) => {
      const file = await request.file();
      if (!file) {
        return reply.status(400).send({ error: 'Aucun fichier reçu.' });
      }
      const extension = path.extname(file.filename).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        return reply.status(400).send({ error: 'Format accepté : image (png, jpg, webp) ou PDF.' });
      }
      const name = `${crypto.randomUUID()}${extension}`;
      await fs.promises.writeFile(path.join(uploadsDir, name), await file.toBuffer());
      return reply.status(201).send({ path: `/uploads/${name}` });
    });

    app.register(fastifyStatic, {
      root: uploadsDir,
      prefix: '/uploads/',
      decorateReply: false,
    });
  }

  // --- Front statique (production) ---

  if (deps.webDistDir && fs.existsSync(deps.webDistDir)) {
    app.register(fastifyStatic, {
      root: deps.webDistDir,
      prefix: '/',
    });
    // SPA fallback : toute route non-API sert index.html.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/uploads/')) {
        return reply.status(404).send({ error: 'Ressource introuvable.' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
