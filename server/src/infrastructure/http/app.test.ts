import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDatabase } from '../persistence/sqlite/database.js';
import {
  SqliteCredentialRepository,
  SqliteDeviceTokenRepository,
  SqliteEquipmentRepository,
  SqliteExpenseRepository,
  SqliteMemberRepository,
  SqliteMessageRepository,
  SqliteThreadRepository,
  SqliteNotificationPreferenceRepository,
  SqliteNotificationRepository,
  SqlitePushSubscriptionRepository,
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
    threads: new SqliteThreadRepository(db),
    messages: new SqliteMessageRepository(db),
    notifications: new SqliteNotificationRepository(db),
    notificationPreferences: new SqliteNotificationPreferenceRepository(db),
    pushSubscriptions: new SqlitePushSubscriptionRepository(db),
    deviceTokens: new SqliteDeviceTokenRepository(db),
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
    expect(usage.json()).toMatchObject({ memberId: m1, duration: 60 });

    // Bruno saisit une durée : le compteur est déduit du dernier relevé (160 + 2 → 162)
    const byDuration = await post('/api/usage', { equipmentId: equipment.id, duration: 2 }, bruno.cookies);
    expect(byDuration.statusCode).toBe(201);
    expect(byDuration.json()).toMatchObject({ memberId: m2, meterReading: 162, duration: 2 });

    const usageHistory = await get(`/api/equipments/${equipment.id}/usage`, alice.cookies);
    expect((usageHistory.json() as { meterReading: number; duration: number | null }[]).map((u) => u.duration)).toEqual(
      expect.arrayContaining([null, 60, 2]),
    );

    const maintenance = await get(`/api/equipments/${equipment.id}/maintenance`, alice.cookies);
    expect(maintenance.json()).toMatchObject({ alert: true, unitsSinceMaintenance: 62 });

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

describe('API — app native (token Bearer)', () => {
  const NATIVE = { 'x-sharemate-client': 'native' };

  it('login natif : le token est renvoyé dans le corps et authentifie via Authorization: Bearer', async () => {
    await bootstrapAlice();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'alice', password: PASSWORD },
      headers: NATIVE,
    });
    expect(login.statusCode).toBe(200);
    const token = (login.json() as { token?: string }).token;
    expect(typeof token).toBe('string');

    // Le token seul (sans cookie) suffit à authentifier une route protégée.
    const protectedRes = await app.inject({
      method: 'GET',
      url: '/api/equipments',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(protectedRes.statusCode).toBe(200);
  });

  it('sans en-tête natif, le token n’est jamais exposé dans le corps (sécurité httpOnly du web)', async () => {
    const res = await post('/api/auth/bootstrap', { name: 'Alice', password: PASSWORD });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { token?: string }).token).toBeUndefined();
  });

  it('un Bearer invalide est rejeté en 401', async () => {
    await bootstrapAlice();
    const res = await app.inject({
      method: 'GET',
      url: '/api/equipments',
      headers: { authorization: 'Bearer jeton-bidon' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('API — CORS (origines de l’app native)', () => {
  let corsApp: FastifyInstance;

  beforeEach(async () => {
    const db = openDatabase(':memory:');
    corsApp = await buildApp({
      members: new SqliteMemberRepository(db),
      equipments: new SqliteEquipmentRepository(db),
      reservations: new SqliteReservationRepository(db),
      usageRecords: new SqliteUsageRecordRepository(db),
      expenses: new SqliteExpenseRepository(db),
      reimbursements: new SqliteReimbursementRepository(db),
      threads: new SqliteThreadRepository(db),
      messages: new SqliteMessageRepository(db),
      notifications: new SqliteNotificationRepository(db),
      notificationPreferences: new SqliteNotificationPreferenceRepository(db),
      pushSubscriptions: new SqlitePushSubscriptionRepository(db),
      deviceTokens: new SqliteDeviceTokenRepository(db),
      credentials: new SqliteCredentialRepository(db),
      sessions: new SqliteSessionRepository(db),
      passwordHasher: new ScryptPasswordHasher(),
      tokenGenerator: new CryptoTokenGenerator(),
      idGenerator: new UuidGenerator(),
      clock: new SystemClock(),
      corsOrigins: ['https://localhost'],
    });
  });

  afterEach(async () => {
    await corsApp.close();
  });

  it('autorise une origine configurée (preflight + réponse)', async () => {
    const preflight = await corsApp.inject({
      method: 'OPTIONS',
      url: '/api/health',
      headers: { origin: 'https://localhost', 'access-control-request-method': 'GET' },
    });
    expect(preflight.headers['access-control-allow-origin']).toBe('https://localhost');

    const res = await corsApp.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://localhost' } });
    expect(res.headers['access-control-allow-origin']).toBe('https://localhost');
  });

  it('n’autorise pas une origine non configurée', async () => {
    const res = await corsApp.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://pirate.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('API — discussions (fils + messages)', () => {
  it('crée un fil avec 1er message, poste/édite/supprime des messages ; le hors-cercle est refusé', async () => {
    const { equipment, alice, bruno, chloe } = await setupMembersAndEquipment();

    // Fil avec premier message.
    const created = await post(
      '/api/threads',
      { equipmentId: equipment.id, title: 'Panne moteur', body: 'Ça démarre plus' },
      alice.cookies,
    );
    expect(created.statusCode).toBe(201);
    const thread = created.json() as { id: string; title: string; authorId: string };
    expect(thread.authorId).toBe(alice.id);

    // Chloé (hors cercle) ne peut pas ouvrir de fil.
    const refused = await post('/api/threads', { equipmentId: equipment.id, title: 'X' }, chloe.cookies);
    expect(refused.statusCode).toBe(400);

    // Liste des fils avec compteur de messages.
    const threads = await get(`/api/equipments/${equipment.id}/threads`, bruno.cookies);
    const summaries = threads.json() as { id: string; messageCount: number }[];
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.messageCount).toBe(1);

    // Bruno répond.
    const reply = await post('/api/messages', { threadId: thread.id, body: 'Vérifie la batterie' }, bruno.cookies);
    expect(reply.statusCode).toBe(201);
    const message = reply.json() as { id: string };

    // Bruno édite son message.
    const edited = await app.inject({
      method: 'PUT',
      url: `/api/messages/${message.id}`,
      payload: { body: 'Vérifie la batterie et le fusible' },
      cookies: bruno.cookies,
    });
    expect(edited.statusCode).toBe(200);
    expect((edited.json() as { body: string; editedAt: string | null }).editedAt).not.toBeNull();

    // Alice ne peut pas éditer le message de Bruno.
    const editOther = await app.inject({
      method: 'PUT',
      url: `/api/messages/${message.id}`,
      payload: { body: 'pirate' },
      cookies: alice.cookies,
    });
    expect(editOther.statusCode).toBe(401);

    // Les messages du fil (1er message + réponse).
    const msgs = await get(`/api/threads/${thread.id}/messages`, alice.cookies);
    expect((msgs.json() as unknown[]).length).toBe(2);

    // Seul l'auteur supprime le fil : Bruno ne peut pas, Alice oui (cascade sur les messages).
    const delByOther = await app.inject({ method: 'DELETE', url: `/api/threads/${thread.id}`, cookies: bruno.cookies });
    expect(delByOther.statusCode).toBe(401);
    const delByAuthor = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${thread.id}`,
      cookies: alice.cookies,
    });
    expect(delByAuthor.statusCode).toBe(204);
    expect(((await get(`/api/equipments/${equipment.id}/threads`, alice.cookies)).json() as unknown[]).length).toBe(0);
  });
});

describe('API — notifications', () => {
  async function openThread(equipmentId: string, cookies: Cookies) {
    const res = await post('/api/threads', { equipmentId, title: 'Sujet' }, cookies);
    return (res.json() as { id: string }).id;
  }

  it('un message notifie le reste du cercle et se marque lu', async () => {
    const { equipment, alice, bruno } = await setupMembersAndEquipment();
    const threadId = await openThread(equipment.id, alice.cookies);
    await post('/api/messages', { threadId, body: 'Salut' }, alice.cookies);

    // Ouverture du fil + message = 2 notifications pour Bruno.
    const count = await get('/api/notifications/unread-count', bruno.cookies);
    expect((count.json() as { count: number }).count).toBe(2);
    // L'auteur ne se notifie pas lui-même.
    expect(((await get('/api/notifications/unread-count', alice.cookies)).json() as { count: number }).count).toBe(0);

    const list = await get('/api/notifications', bruno.cookies);
    const notif = (list.json() as { id: string; type: string }[])[0]!;
    expect(notif.type).toBe('MESSAGE_POSTED');

    const read = await post(`/api/notifications/${notif.id}/read`, {}, bruno.cookies);
    expect(read.statusCode).toBe(204);
    expect(((await get('/api/notifications/unread-count', bruno.cookies)).json() as { count: number }).count).toBe(1);
  });

  it('respecte les préférences (in-app désactivé ⇒ pas de notification)', async () => {
    const { equipment, alice, bruno } = await setupMembersAndEquipment();

    const prefs = await app.inject({
      method: 'PUT',
      url: '/api/notifications/preferences',
      payload: { preferences: [{ type: 'MESSAGE_POSTED', inApp: false, push: false }] },
      cookies: bruno.cookies,
    });
    expect(prefs.statusCode).toBe(200);

    const threadId = await openThread(equipment.id, alice.cookies);
    await post('/api/messages', { threadId, body: 'Silencieux' }, alice.cookies);
    expect(((await get('/api/notifications/unread-count', bruno.cookies)).json() as { count: number }).count).toBe(0);
  });

  it('expose la clé publique VAPID (null si non configurée)', async () => {
    const alice = await bootstrapAlice();
    const res = await get('/api/notifications/vapid-public-key', alice.cookies);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ publicKey: null });
  });
});
