import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDatabase } from '../persistence/sqlite/database.js';
import {
  SqliteEquipmentRepository,
  SqliteExpenseRepository,
  SqliteGroupRepository,
  SqliteMemberRepository,
  SqliteReimbursementRepository,
  SqliteReservationRepository,
  SqliteUsageRecordRepository,
} from '../persistence/sqlite/repositories.js';
import { SystemClock, UuidGenerator } from '../tech/adapters.js';
import { buildApp } from './app.js';

let app: FastifyInstance;

beforeEach(() => {
  const db = openDatabase(':memory:');
  app = buildApp({
    groups: new SqliteGroupRepository(db),
    members: new SqliteMemberRepository(db),
    equipments: new SqliteEquipmentRepository(db),
    reservations: new SqliteReservationRepository(db),
    usageRecords: new SqliteUsageRecordRepository(db),
    expenses: new SqliteExpenseRepository(db),
    reimbursements: new SqliteReimbursementRepository(db),
    idGenerator: new UuidGenerator(),
    clock: new SystemClock(),
  });
});

afterEach(async () => {
  await app.close();
});

async function post(url: string, body: unknown) {
  return app.inject({ method: 'POST', url, payload: body as Record<string, unknown> });
}

async function setupGroupAndEquipment() {
  const groupRes = await post('/api/groups', {
    name: 'Les voisins',
    members: [{ name: 'Alice' }, { name: 'Bruno' }, { name: 'Chloé' }],
  });
  const group = groupRes.json() as { id: string; memberIds: string[] };
  const [m1, m2, m3] = group.memberIds;
  const equipmentRes = await post('/api/equipments', {
    groupId: group.id,
    name: 'Minipelle',
    category: 'BTP',
    acquisitionDate: '2025-01-01',
    purchaseValueEuros: 15000,
    meterUnit: 'HOURS',
    accessMemberIds: [m1, m2],
    maintenanceThreshold: 50,
  });
  const equipment = equipmentRes.json() as { id: string };
  return { group, equipment, m1: m1!, m2: m2!, m3: m3! };
}

describe('API — santé', () => {
  it('GET /api/health répond ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('API — parcours complet du MVP', () => {
  it('groupe → équipement → réservation → usage → dépense → solde', async () => {
    const { group, equipment, m1, m2 } = await setupGroupAndEquipment();

    // Réservation
    const r1 = await post('/api/reservations', {
      equipmentId: equipment.id,
      memberId: m1,
      start: '2026-07-10T08:00:00Z',
      end: '2026-07-10T14:00:00Z',
    });
    expect(r1.statusCode).toBe(201);

    // Conflit détecté
    const conflict = await post('/api/reservations', {
      equipmentId: equipment.id,
      memberId: m2,
      start: '2026-07-10T10:00:00Z',
      end: '2026-07-10T12:00:00Z',
    });
    expect(conflict.statusCode).toBe(409);

    // Créneau libre pour m2 (2 h)
    const r2 = await post('/api/reservations', {
      equipmentId: equipment.id,
      memberId: m2,
      start: '2026-07-11T08:00:00Z',
      end: '2026-07-11T10:00:00Z',
    });
    expect(r2.statusCode).toBe(201);

    // Calendrier du groupe
    const calendar = await app.inject({ method: 'GET', url: `/api/groups/${group.id}/calendar` });
    expect(calendar.json()).toHaveLength(2);

    // Relevés d'usage : maintenance à 100 h puis relevé à 160 h → alerte (seuil 50)
    await post('/api/usage', { equipmentId: equipment.id, memberId: m1, meterReading: 100, isMaintenance: true });
    const usage = await post('/api/usage', {
      equipmentId: equipment.id,
      memberId: m1,
      meterReading: 160,
      fuelAddedLiters: 12,
      notes: 'Tranchée jardin',
    });
    expect(usage.statusCode).toBe(201);

    const maintenance = await app.inject({ method: 'GET', url: `/api/equipments/${equipment.id}/maintenance` });
    expect(maintenance.json()).toMatchObject({ alert: true, unitsSinceMaintenance: 60 });

    const alerts = await app.inject({ method: 'GET', url: `/api/groups/${group.id}/alerts` });
    expect(alerts.json()).toHaveLength(1);

    // Dépense carburant au prorata d'usage : m1 a 6 h de réservation, m2 en a 2 → 75 % / 25 %
    const expense = await post('/api/expenses', {
      groupId: group.id,
      equipmentId: equipment.id,
      label: 'Plein gasoil',
      amountEuros: 100,
      payerId: m2,
      date: '2026-07-12',
      category: 'FUEL',
      split: { type: 'USAGE_PRORATED' },
    });
    expect(expense.statusCode).toBe(201);
    expect((expense.json() as { sharesEuros: Record<string, number> }).sharesEuros[m1]).toBe(75);

    // Soldes : m2 a payé 100, doit 25 → +75 ; m1 doit 75 → -75
    const balances = await app.inject({ method: 'GET', url: `/api/groups/${group.id}/balances` });
    const byMember = Object.fromEntries(
      (balances.json() as { memberId: string; balanceEuros: number }[]).map((b) => [b.memberId, b.balanceEuros]),
    );
    expect(byMember[m1]).toBe(-75);
    expect(byMember[m2]).toBe(75);

    // Plan de remboursement minimal : 1 transaction m1 → m2
    const settlement = await app.inject({ method: 'GET', url: `/api/groups/${group.id}/settlement` });
    expect(settlement.json()).toEqual([{ fromMemberId: m1, toMemberId: m2, amountEuros: 75 }]);

    // Remboursement déclaré → soldes apurés
    await post('/api/reimbursements', {
      groupId: group.id,
      fromMemberId: m1,
      toMemberId: m2,
      amountEuros: 75,
      date: '2026-07-13',
    });
    const settled = await app.inject({ method: 'GET', url: `/api/groups/${group.id}/settlement` });
    expect(settled.json()).toEqual([]);
  });

  it('CRUD équipement via l\'API', async () => {
    const { group, equipment } = await setupGroupAndEquipment();

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/equipments/${equipment.id}`,
      payload: { name: 'Minipelle 2T' },
    });
    expect((updated.json() as { name: string }).name).toBe('Minipelle 2T');

    const list = await app.inject({ method: 'GET', url: `/api/groups/${group.id}/equipments` });
    expect(list.json()).toHaveLength(1);

    const del = await app.inject({ method: 'DELETE', url: `/api/equipments/${equipment.id}` });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: `/api/groups/${group.id}/equipments` });
    expect(after.json()).toHaveLength(0);
  });

  it('erreurs métier correctement mappées', async () => {
    const { equipment, m3 } = await setupGroupAndEquipment();

    // 400 : membre sans accès
    const forbidden = await post('/api/reservations', {
      equipmentId: equipment.id,
      memberId: m3,
      start: '2026-07-10T08:00:00Z',
      end: '2026-07-10T10:00:00Z',
    });
    expect(forbidden.statusCode).toBe(400);

    // 404 : équipement inexistant
    const notFound = await app.inject({ method: 'GET', url: '/api/equipments/nope' });
    expect(notFound.statusCode).toBe(404);
  });
});
