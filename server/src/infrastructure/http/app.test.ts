import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDatabase } from '../persistence/sqlite/database.js';
import {
  SqliteCredentialRepository,
  SqliteEquipmentRepository,
  SqliteExpenseRepository,
  SqliteMemberRepository,
  SqliteReimbursementRepository,
  SqliteReservationRepository,
  SqliteSessionRepository,
  SqliteUsageRecordRepository,
} from '../persistence/sqlite/repositories.js';
import { CryptoTokenGenerator, ScryptPasswordHasher, SystemClock, UuidGenerator } from '../tech/adapters.js';
import { buildApp } from './app.js';

const PASSWORD = 'motdepasse';
type Cookies = Record<string, string>;

let app: FastifyInstance;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  app = await buildApp({
    members: new SqliteMemberRepository(db),
    equipments: new SqliteEquipmentRepository(db),
    reservations: new SqliteReservationRepository(db),
    usageRecords: new SqliteUsageRecordRepository(db),
    expenses: new SqliteExpenseRepository(db),
    reimbursements: new SqliteReimbursementRepository(db),
    credentials: new SqliteCredentialRepository(db),
    sessions: new SqliteSessionRepository(db),
    passwordHasher: new ScryptPasswordHasher(),
    tokenGenerator: new CryptoTokenGenerator(),
    idGenerator: new UuidGenerator(),
    clock: new SystemClock(),
  });
});

afterEach(async () => {
  await app.close();
});

async function post(url: string, body: unknown, cookies?: Cookies) {
  return app.inject({ method: 'POST', url, payload: body as Record<string, unknown>, cookies });
}

async function get(url: string, cookies?: Cookies) {
  return app.inject({ method: 'GET', url, cookies });
}

function sessionCookie(res: { cookies: { name: string; value: string }[] }): Cookies {
  const cookie = res.cookies.find((c) => c.name === 'sharemate_session');
  if (!cookie) throw new Error('Cookie de session absent de la réponse.');
  return { sharemate_session: cookie.value };
}

/** Premier compte (Alice) via bootstrap : renvoie son id et sa session. */
async function bootstrapAlice() {
  const res = await post('/api/auth/bootstrap', { name: 'Alice', password: PASSWORD });
  expect(res.statusCode).toBe(201);
  return { id: (res.json() as { member: { id: string } }).member.id, cookies: sessionCookie(res) };
}

/** Crée un membre (invité), consomme son invitation et renvoie id + session. */
async function inviteAndRedeem(name: string, creatorCookies: Cookies) {
  const created = await post('/api/members', { name }, creatorCookies);
  expect(created.statusCode).toBe(201);
  const { id, inviteCode } = created.json() as { id: string; inviteCode: string };
  const redeemed = await post(`/api/auth/invites/${inviteCode}/redeem`, { password: PASSWORD });
  expect(redeemed.statusCode).toBe(200);
  return { id, cookies: sessionCookie(redeemed) };
}

/** Trois membres connectés ; la minipelle porte le cercle m1/m2, m3 reste en dehors. */
async function setupMembersAndEquipment() {
  const alice = await bootstrapAlice();
  const bruno = await inviteAndRedeem('Bruno', alice.cookies);
  const chloe = await inviteAndRedeem('Chloé', alice.cookies);
  const equipmentRes = await post(
    '/api/equipments',
    {
      name: 'Minipelle',
      category: 'BTP',
      acquisitionDate: '2025-01-01',
      purchaseValueEuros: 15000,
      meterUnit: 'HOURS',
      memberIds: [alice.id, bruno.id],
      maintenanceThreshold: 50,
    },
    alice.cookies,
  );
  const equipment = equipmentRes.json() as { id: string; memberIds: string[] };
  return { equipment, alice, bruno, chloe };
}

describe('API — santé', () => {
  it('GET /api/health répond ok sans session', async () => {
    const res = await get('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('API — authentification', () => {
  it('sans session, l’API répond 401', async () => {
    for (const url of ['/api/equipments', '/api/members', '/api/calendar', '/api/alerts']) {
      expect((await get(url)).statusCode).toBe(401);
    }
    expect((await post('/api/reservations', {})).statusCode).toBe(401);
  });

  it('me : needsBootstrap au départ, puis membre connecté après bootstrap', async () => {
    const before = await get('/api/auth/me');
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ member: null, needsBootstrap: true });

    const alice = await bootstrapAlice();
    const after = await get('/api/auth/me', alice.cookies);
    expect((after.json() as { member: { name: string } }).member.name).toBe('Alice');
    expect((after.json() as { needsBootstrap: boolean }).needsBootstrap).toBe(false);
  });

  it('le bootstrap est unique', async () => {
    await bootstrapAlice();
    const second = await post('/api/auth/bootstrap', { name: 'Intrus', password: PASSWORD });
    expect(second.statusCode).toBe(409);
  });

  it('login par nom, mauvais mot de passe rejeté en 401', async () => {
    await bootstrapAlice();
    const bad = await post('/api/auth/login', { identifier: 'Alice', password: 'mauvais-mdp' });
    expect(bad.statusCode).toBe(401);

    const ok = await post('/api/auth/login', { identifier: 'alice', password: PASSWORD });
    expect(ok.statusCode).toBe(200);
    expect((await get('/api/equipments', sessionCookie(ok))).statusCode).toBe(200);
  });

  it('une invitation ne se consomme qu’une fois', async () => {
    const alice = await bootstrapAlice();
    const created = await post('/api/members', { name: 'Bruno' }, alice.cookies);
    const { inviteCode } = created.json() as { inviteCode: string };

    const info = await get(`/api/auth/invites/${inviteCode}`);
    expect(info.json()).toEqual({ memberName: 'Bruno' });

    expect((await post(`/api/auth/invites/${inviteCode}/redeem`, { password: PASSWORD })).statusCode).toBe(200);
    expect((await get(`/api/auth/invites/${inviteCode}`)).statusCode).toBe(404);
    expect((await post(`/api/auth/invites/${inviteCode}/redeem`, { password: PASSWORD })).statusCode).toBe(404);
  });

  it('régénération d’invitation pour un membre existant', async () => {
    const alice = await bootstrapAlice();
    const bruno = await inviteAndRedeem('Bruno', alice.cookies);
    const res = await post(`/api/members/${bruno.id}/invite`, {}, alice.cookies);
    expect(res.statusCode).toBe(201);
    const { inviteCode } = res.json() as { inviteCode: string };
    expect((await get(`/api/auth/invites/${inviteCode}`)).statusCode).toBe(200);
  });

  it('le login est limité contre le force brute (429 au-delà de 10/min)', async () => {
    await bootstrapAlice();
    for (let i = 0; i < 10; i++) {
      expect((await post('/api/auth/login', { identifier: 'Personne', password: 'xxxxxxxx' })).statusCode).toBe(401);
    }
    expect((await post('/api/auth/login', { identifier: 'Personne', password: 'xxxxxxxx' })).statusCode).toBe(429);
  });

  it('logout invalide la session', async () => {
    const alice = await bootstrapAlice();
    expect((await post('/api/auth/logout', {}, alice.cookies)).statusCode).toBe(204);
    expect((await get('/api/equipments', alice.cookies)).statusCode).toBe(401);
  });

  it('changement de mot de passe', async () => {
    const alice = await bootstrapAlice();
    const wrong = await post(
      '/api/auth/password',
      { currentPassword: 'mauvais-mdp', newPassword: 'nouveau-mdp' },
      alice.cookies,
    );
    expect(wrong.statusCode).toBe(401);

    const ok = await post(
      '/api/auth/password',
      { currentPassword: PASSWORD, newPassword: 'nouveau-mdp' },
      alice.cookies,
    );
    expect(ok.statusCode).toBe(204);
    expect((await post('/api/auth/login', { identifier: 'Alice', password: 'nouveau-mdp' })).statusCode).toBe(200);
  });

  it('la réservation est créée au nom du membre de la session, pas du body', async () => {
    const { equipment, alice, bruno } = await setupMembersAndEquipment();
    const res = await post(
      '/api/reservations',
      {
        equipmentId: equipment.id,
        memberId: alice.id, // ignoré : la session de Bruno prime
        start: '2026-07-10T08:00:00Z',
        end: '2026-07-10T10:00:00Z',
      },
      bruno.cookies,
    );
    expect(res.statusCode).toBe(201);
    expect((res.json() as { memberId: string }).memberId).toBe(bruno.id);
  });
});

describe('API — parcours complet du MVP', () => {
  it('membres → équipement (cercle) → réservation → usage → dépense → solde', async () => {
    const { equipment, alice, bruno } = await setupMembersAndEquipment();
    const m1 = alice.id;
    const m2 = bruno.id;
    expect(equipment.memberIds).toEqual([m1, m2]);

    // Réservation d'Alice (6 h)
    const r1 = await post(
      '/api/reservations',
      { equipmentId: equipment.id, start: '2026-07-10T08:00:00Z', end: '2026-07-10T14:00:00Z' },
      alice.cookies,
    );
    expect(r1.statusCode).toBe(201);

    // Conflit signalé mais non bloquant : les deux réservations coexistent
    const conflict = await post(
      '/api/reservations',
      { equipmentId: equipment.id, start: '2026-07-10T10:00:00Z', end: '2026-07-10T12:00:00Z' },
      bruno.cookies,
    );
    expect(conflict.statusCode).toBe(201);
    expect(conflict.json().conflictIds).toEqual([r1.json().id]);
    const cancelConflicting = await app.inject({
      method: 'DELETE',
      url: `/api/reservations/${conflict.json().id}`,
      cookies: bruno.cookies,
    });
    expect(cancelConflicting.statusCode).toBe(204);

    // Créneau libre pour Bruno (2 h)
    const r2 = await post(
      '/api/reservations',
      { equipmentId: equipment.id, start: '2026-07-11T08:00:00Z', end: '2026-07-11T10:00:00Z' },
      bruno.cookies,
    );
    expect(r2.statusCode).toBe(201);

    // Calendrier partagé (tous équipements)
    const calendar = await get('/api/calendar', alice.cookies);
    expect(calendar.json()).toHaveLength(2);

    // Relevés d'usage : maintenance à 100 h puis relevé à 160 h → alerte (seuil 50)
    await post('/api/usage', { equipmentId: equipment.id, meterReading: 100, isMaintenance: true }, alice.cookies);
    const usage = await post(
      '/api/usage',
      { equipmentId: equipment.id, meterReading: 160, fuelAddedLiters: 12, notes: 'Tranchée jardin' },
      alice.cookies,
    );
    expect(usage.statusCode).toBe(201);
    expect((usage.json() as { memberId: string }).memberId).toBe(m1);

    const maintenance = await get(`/api/equipments/${equipment.id}/maintenance`, alice.cookies);
    expect(maintenance.json()).toMatchObject({ alert: true, unitsSinceMaintenance: 60 });

    const alerts = await get('/api/alerts', alice.cookies);
    expect(alerts.json()).toHaveLength(1);

    // Dépense carburant au prorata d'usage : m1 a 6 h de réservation, m2 en a 2 → 75 % / 25 %
    const expense = await post(
      '/api/expenses',
      {
        equipmentId: equipment.id,
        label: 'Plein gasoil',
        amountEuros: 100,
        payerId: m2,
        date: '2026-07-12',
        category: 'FUEL',
        split: { type: 'USAGE_PRORATED' },
      },
      bruno.cookies,
    );
    expect(expense.statusCode).toBe(201);
    expect((expense.json() as { sharesEuros: Record<string, number> }).sharesEuros[m1]).toBe(75);

    // Soldes du cercle : m2 a payé 100, doit 25 → +75 ; m1 doit 75 → -75
    const balances = await get(`/api/equipments/${equipment.id}/balances`, alice.cookies);
    const byMember = Object.fromEntries(
      (balances.json() as { memberId: string; balanceEuros: number }[]).map((b) => [b.memberId, b.balanceEuros]),
    );
    expect(byMember[m1]).toBe(-75);
    expect(byMember[m2]).toBe(75);

    // Plan de remboursement minimal : 1 transaction m1 → m2
    const settlement = await get(`/api/equipments/${equipment.id}/settlement`, alice.cookies);
    expect(settlement.json()).toEqual([{ fromMemberId: m1, toMemberId: m2, amountEuros: 75 }]);

    // Remboursement déclaré → soldes apurés
    await post(
      '/api/reimbursements',
      { equipmentId: equipment.id, fromMemberId: m1, toMemberId: m2, amountEuros: 75, date: '2026-07-13' },
      alice.cookies,
    );
    const settled = await get(`/api/equipments/${equipment.id}/settlement`, alice.cookies);
    expect(settled.json()).toEqual([]);
  });

  it('un membre partage deux équipements avec deux cercles distincts', async () => {
    const { equipment, alice, chloe } = await setupMembersAndEquipment();
    const m1 = alice.id;
    const m3 = chloe.id;

    // Alice partage aussi un broyeur avec Chloé (cercle distinct de la minipelle)
    const broyeur = await post(
      '/api/equipments',
      {
        name: 'Broyeur',
        category: 'Jardin',
        acquisitionDate: '2025-06-01',
        purchaseValueEuros: 2000,
        meterUnit: 'HOURS',
        memberIds: [m1, m3],
        maintenanceThreshold: null,
      },
      alice.cookies,
    );
    expect(broyeur.statusCode).toBe(201);

    const list = await get('/api/equipments', alice.cookies);
    const equipments = list.json() as { id: string; memberIds: string[] }[];
    expect(equipments).toHaveLength(2);
    const circles = Object.fromEntries(equipments.map((e) => [e.id, e.memberIds]));
    expect(circles[equipment.id]).not.toEqual(circles[(broyeur.json() as { id: string }).id]);

    // Les dépenses du broyeur ne concernent que son cercle : Bruno en est exclu
    const invalid = await post(
      '/api/expenses',
      {
        equipmentId: (broyeur.json() as { id: string }).id,
        label: 'Courroie',
        amountEuros: 40,
        payerId: m1,
        date: '2026-07-12',
        category: 'REPAIR',
        split: { type: 'EQUAL' },
      },
      alice.cookies,
    );
    expect(invalid.statusCode).toBe(201);
    const shares = (invalid.json() as { sharesEuros: Record<string, number> }).sharesEuros;
    expect(Object.keys(shares).sort()).toEqual([m1, m3].sort());
  });

  it("CRUD équipement via l'API", async () => {
    const { equipment, alice, bruno, chloe } = await setupMembersAndEquipment();
    const [m1, m2, m3] = [alice.id, bruno.id, chloe.id];

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/equipments/${equipment.id}`,
      payload: { name: 'Minipelle 2T', memberIds: [m1, m2, m3] },
      cookies: alice.cookies,
    });
    expect((updated.json() as { name: string }).name).toBe('Minipelle 2T');
    expect((updated.json() as { memberIds: string[] }).memberIds).toEqual([m1, m2, m3]);

    const list = await get('/api/equipments', alice.cookies);
    expect(list.json()).toHaveLength(1);

    const del = await app.inject({ method: 'DELETE', url: `/api/equipments/${equipment.id}`, cookies: alice.cookies });
    expect(del.statusCode).toBe(204);
    const after = await get('/api/equipments', alice.cookies);
    expect(after.json()).toHaveLength(0);
  });

  it('erreurs métier correctement mappées', async () => {
    const { equipment, alice, chloe } = await setupMembersAndEquipment();

    // 400 : membre hors du cercle de l'équipement (Chloé agit via sa propre session)
    const forbidden = await post(
      '/api/reservations',
      { equipmentId: equipment.id, start: '2026-07-10T08:00:00Z', end: '2026-07-10T10:00:00Z' },
      chloe.cookies,
    );
    expect(forbidden.statusCode).toBe(400);

    // 400 : cercle avec un membre inconnu
    const unknownMember = await post(
      '/api/equipments',
      {
        name: 'X',
        category: 'C',
        acquisitionDate: '2025-01-01',
        purchaseValueEuros: 10,
        meterUnit: 'HOURS',
        memberIds: ['fantome'],
      },
      alice.cookies,
    );
    expect(unknownMember.statusCode).toBe(400);

    // 404 : équipement inexistant
    const notFound = await get('/api/equipments/nope', alice.cookies);
    expect(notFound.statusCode).toBe(404);
  });
});
