import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDatabase } from '../persistence/sqlite/database.js';
import {
  SqliteEquipmentRepository,
  SqliteExpenseRepository,
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

/** Trois membres ; la minipelle porte le cercle m1/m2, m3 reste en dehors. */
async function setupMembersAndEquipment() {
  const ids: string[] = [];
  for (const name of ['Alice', 'Bruno', 'Chloé']) {
    const res = await post('/api/members', { name });
    ids.push((res.json() as { id: string }).id);
  }
  const [m1, m2, m3] = ids;
  const equipmentRes = await post('/api/equipments', {
    name: 'Minipelle',
    category: 'BTP',
    acquisitionDate: '2025-01-01',
    purchaseValueEuros: 15000,
    meterUnit: 'HOURS',
    memberIds: [m1, m2],
    maintenanceThreshold: 50,
  });
  const equipment = equipmentRes.json() as { id: string; memberIds: string[] };
  return { equipment, m1: m1!, m2: m2!, m3: m3! };
}

describe('API — santé', () => {
  it('GET /api/health répond ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('API — parcours complet du MVP', () => {
  it('membres → équipement (cercle) → réservation → usage → dépense → solde', async () => {
    const { equipment, m1, m2 } = await setupMembersAndEquipment();
    expect(equipment.memberIds).toEqual([m1, m2]);

    // Réservation
    const r1 = await post('/api/reservations', {
      equipmentId: equipment.id,
      memberId: m1,
      start: '2026-07-10T08:00:00Z',
      end: '2026-07-10T14:00:00Z',
    });
    expect(r1.statusCode).toBe(201);

    // Conflit signalé mais non bloquant : les deux réservations coexistent
    const conflict = await post('/api/reservations', {
      equipmentId: equipment.id,
      memberId: m2,
      start: '2026-07-10T10:00:00Z',
      end: '2026-07-10T12:00:00Z',
    });
    expect(conflict.statusCode).toBe(201);
    expect(conflict.json().conflictIds).toEqual([r1.json().id]);
    const cancelConflicting = await app.inject({
      method: 'DELETE',
      url: `/api/reservations/${conflict.json().id}`,
    });
    expect(cancelConflicting.statusCode).toBe(204);

    // Créneau libre pour m2 (2 h)
    const r2 = await post('/api/reservations', {
      equipmentId: equipment.id,
      memberId: m2,
      start: '2026-07-11T08:00:00Z',
      end: '2026-07-11T10:00:00Z',
    });
    expect(r2.statusCode).toBe(201);

    // Calendrier partagé (tous équipements)
    const calendar = await app.inject({ method: 'GET', url: '/api/calendar' });
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

    const alerts = await app.inject({ method: 'GET', url: '/api/alerts' });
    expect(alerts.json()).toHaveLength(1);

    // Dépense carburant au prorata d'usage : m1 a 6 h de réservation, m2 en a 2 → 75 % / 25 %
    const expense = await post('/api/expenses', {
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

    // Soldes du cercle : m2 a payé 100, doit 25 → +75 ; m1 doit 75 → -75
    const balances = await app.inject({ method: 'GET', url: `/api/equipments/${equipment.id}/balances` });
    const byMember = Object.fromEntries(
      (balances.json() as { memberId: string; balanceEuros: number }[]).map((b) => [b.memberId, b.balanceEuros]),
    );
    expect(byMember[m1]).toBe(-75);
    expect(byMember[m2]).toBe(75);

    // Plan de remboursement minimal : 1 transaction m1 → m2
    const settlement = await app.inject({ method: 'GET', url: `/api/equipments/${equipment.id}/settlement` });
    expect(settlement.json()).toEqual([{ fromMemberId: m1, toMemberId: m2, amountEuros: 75 }]);

    // Remboursement déclaré → soldes apurés
    await post('/api/reimbursements', {
      equipmentId: equipment.id,
      fromMemberId: m1,
      toMemberId: m2,
      amountEuros: 75,
      date: '2026-07-13',
    });
    const settled = await app.inject({ method: 'GET', url: `/api/equipments/${equipment.id}/settlement` });
    expect(settled.json()).toEqual([]);
  });

  it('un membre partage deux équipements avec deux cercles distincts', async () => {
    const { equipment, m1, m3 } = await setupMembersAndEquipment();

    // m1 partage aussi un broyeur avec m3 (cercle distinct de la minipelle)
    const broyeur = await post('/api/equipments', {
      name: 'Broyeur',
      category: 'Jardin',
      acquisitionDate: '2025-06-01',
      purchaseValueEuros: 2000,
      meterUnit: 'HOURS',
      memberIds: [m1, m3],
      maintenanceThreshold: null,
    });
    expect(broyeur.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/api/equipments' });
    const equipments = list.json() as { id: string; memberIds: string[] }[];
    expect(equipments).toHaveLength(2);
    const circles = Object.fromEntries(equipments.map((e) => [e.id, e.memberIds]));
    expect(circles[equipment.id]).not.toEqual(circles[(broyeur.json() as { id: string }).id]);

    // Les dépenses du broyeur ne concernent que son cercle : m2 en est exclu
    const invalid = await post('/api/expenses', {
      equipmentId: (broyeur.json() as { id: string }).id,
      label: 'Courroie',
      amountEuros: 40,
      payerId: m1,
      date: '2026-07-12',
      category: 'REPAIR',
      split: { type: 'EQUAL' },
    });
    expect(invalid.statusCode).toBe(201);
    const shares = (invalid.json() as { sharesEuros: Record<string, number> }).sharesEuros;
    expect(Object.keys(shares).sort()).toEqual([m1, m3].sort());
  });

  it('CRUD équipement via l\'API', async () => {
    const { equipment, m1, m2, m3 } = await setupMembersAndEquipment();

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/equipments/${equipment.id}`,
      payload: { name: 'Minipelle 2T', memberIds: [m1, m2, m3] },
    });
    expect((updated.json() as { name: string }).name).toBe('Minipelle 2T');
    expect((updated.json() as { memberIds: string[] }).memberIds).toEqual([m1, m2, m3]);

    const list = await app.inject({ method: 'GET', url: '/api/equipments' });
    expect(list.json()).toHaveLength(1);

    const del = await app.inject({ method: 'DELETE', url: `/api/equipments/${equipment.id}` });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: '/api/equipments' });
    expect(after.json()).toHaveLength(0);
  });

  it('erreurs métier correctement mappées', async () => {
    const { equipment, m3 } = await setupMembersAndEquipment();

    // 400 : membre hors du cercle de l'équipement
    const forbidden = await post('/api/reservations', {
      equipmentId: equipment.id,
      memberId: m3,
      start: '2026-07-10T08:00:00Z',
      end: '2026-07-10T10:00:00Z',
    });
    expect(forbidden.statusCode).toBe(400);

    // 400 : cercle avec un membre inconnu
    const unknownMember = await post('/api/equipments', {
      name: 'X',
      category: 'C',
      acquisitionDate: '2025-01-01',
      purchaseValueEuros: 10,
      meterUnit: 'HOURS',
      memberIds: ['fantome'],
    });
    expect(unknownMember.statusCode).toBe(400);

    // 404 : équipement inexistant
    const notFound = await app.inject({ method: 'GET', url: '/api/equipments/nope' });
    expect(notFound.statusCode).toBe(404);
  });
});
