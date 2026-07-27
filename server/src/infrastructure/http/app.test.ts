import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDatabase } from '../persistence/sqlite/database.js';
import {
  SqliteChecklistItemRepository,
  SqliteChecklistRepository,
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
import { FixedClock } from '../../application/testing/in-memory.js';
import { buildApp } from './app.js';
import type { AppDependencies } from './app.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PASSWORD = 'motdepasse';
type Cookies = Record<string, string>;

let app: FastifyInstance;

/** App branchée sur une base SQLite neuve ; `overrides` ajoute ou remplace des dépendances. */
async function buildTestApp(overrides: Partial<AppDependencies> = {}): Promise<FastifyInstance> {
  const db = openDatabase(':memory:');
  return buildApp({
    members: new SqliteMemberRepository(db),
    equipments: new SqliteEquipmentRepository(db),
    reservations: new SqliteReservationRepository(db),
    usageRecords: new SqliteUsageRecordRepository(db),
    expenses: new SqliteExpenseRepository(db),
    reimbursements: new SqliteReimbursementRepository(db),
    threads: new SqliteThreadRepository(db),
    messages: new SqliteMessageRepository(db),
    checklists: new SqliteChecklistRepository(db),
    checklistItems: new SqliteChecklistItemRepository(db),
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
    ...overrides,
  });
}

beforeEach(async () => {
  app = await buildTestApp();
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

describe('API — justificatifs et front statique (@fastify/static)', () => {
  let staticApp: FastifyInstance;
  let uploadsDir: string;
  let webDistDir: string;
  let tmpRoot: string;

  /** Corps multipart minimal : `app.inject` n'a pas de constructeur de formulaire. */
  function filePayload(filename: string, content: Buffer, contentType = 'image/png') {
    const boundary = '----sharemateTestBoundary';
    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`;
    return {
      payload: Buffer.concat([Buffer.from(head), content, Buffer.from(`\r\n--${boundary}--\r\n`)]),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  }

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharemate-static-'));
    uploadsDir = path.join(tmpRoot, 'uploads');
    webDistDir = path.join(tmpRoot, 'dist');
    fs.mkdirSync(webDistDir, { recursive: true });
    fs.writeFileSync(path.join(webDistDir, 'index.html'), '<!doctype html><title>ShareMate</title>');
    // Un fichier à l'extérieur du répertoire servi, cible d'une éventuelle traversée.
    fs.writeFileSync(path.join(tmpRoot, 'secret.txt'), 'SECRET-HORS-RACINE');

    staticApp = await buildTestApp({ uploadsDir, webDistDir });
  });

  afterEach(async () => {
    await staticApp.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Session du premier compte sur cette app dédiée. */
  async function session(): Promise<Cookies> {
    const res = await staticApp.inject({
      method: 'POST',
      url: '/api/auth/bootstrap',
      payload: { name: 'Alice', password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    return sessionCookie(res);
  }

  it('téléverse un justificatif, puis ne le sert qu’avec une session', async () => {
    const cookies = await session();
    const contenu = Buffer.from('image-factice');
    const { payload, headers } = filePayload('recu.png', contenu);
    const upload = await staticApp.inject({ method: 'POST', url: '/api/uploads/receipts', payload, headers, cookies });
    expect(upload.statusCode).toBe(201);
    const { path: servedPath } = upload.json() as { path: string };
    expect(servedPath).toMatch(/^\/uploads\/[\w-]+\.png$/);

    const authentifié = await staticApp.inject({ method: 'GET', url: servedPath, cookies });
    expect(authentifié.statusCode).toBe(200);
    expect(authentifié.rawPayload.equals(contenu)).toBe(true);

    // Sans session, le justificatif reste inaccessible.
    const anonyme = await staticApp.inject({ method: 'GET', url: servedPath });
    expect(anonyme.statusCode).toBe(401);
  });

  it('refuse les formats non autorisés', async () => {
    const cookies = await session();
    const { payload, headers } = filePayload('charge.svg', Buffer.from('<svg/>'), 'image/svg+xml');
    const res = await staticApp.inject({ method: 'POST', url: '/api/uploads/receipts', payload, headers, cookies });
    expect(res.statusCode).toBe(400);
  });

  it('ne sert aucun justificatif via un chemin non canonique ou une traversée (GHSA-8pvw / GHSA-83w8)', async () => {
    const cookies = await session();
    const contenu = Buffer.from('justificatif-confidentiel');
    const { payload, headers } = filePayload('recu.png', contenu);
    const upload = await staticApp.inject({ method: 'POST', url: '/api/uploads/receipts', payload, headers, cookies });
    const nom = (upload.json() as { path: string }).path.split('/').pop() as string;

    // Variantes non canoniques du chemin : aucune ne doit livrer le fichier sans session.
    const sondages = [
      `//uploads/${nom}`,
      `/uploads//${nom}`,
      `/./uploads/${nom}`,
      `/uploads/./${nom}`,
      `/uploads/%2e%2f${nom}`,
      `/UPLOADS/${nom}`,
    ];
    for (const url of sondages) {
      const res = await staticApp.inject({ method: 'GET', url });
      expect(res.rawPayload.includes(contenu), `${url} a livré le justificatif sans session`).toBe(false);
    }

    // Traversée de répertoire : le fichier hors racine ne doit jamais sortir, même authentifié.
    const traversées = [
      '/uploads/../secret.txt',
      '/uploads/..%2fsecret.txt',
      '/uploads/%2e%2e%2fsecret.txt',
      '/uploads/....//secret.txt',
    ];
    for (const url of traversées) {
      const res = await staticApp.inject({ method: 'GET', url, cookies });
      expect(res.payload.includes('SECRET-HORS-RACINE'), `${url} a livré un fichier hors racine`).toBe(false);
    }
  });

  it('sert le front et retombe sur index.html pour les routes SPA', async () => {
    const cookies = await session();
    const index = await staticApp.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.payload).toContain('ShareMate');

    // Route front inconnue : index.html (rendu côté client), pas un 404.
    const spa = await staticApp.inject({ method: 'GET', url: '/invite/abc123' });
    expect(spa.statusCode).toBe(200);
    expect(spa.payload).toContain('ShareMate');

    // Une route d'API inconnue reste un 404 JSON (401 sans session : le hook passe avant).
    expect((await staticApp.inject({ method: 'GET', url: '/api/inconnu' })).statusCode).toBe(401);
    const api = await staticApp.inject({ method: 'GET', url: '/api/inconnu', cookies });
    expect(api.statusCode).toBe(404);
    expect((api.json() as { error: string }).error).toBeTruthy();
  });
});

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

  it('régénération d’invitation pour un membre qui n’a pas encore ouvert son compte', async () => {
    const alice = await bootstrapAlice();
    const created = await post('/api/members', { name: 'Bruno' }, alice.cookies);
    const bruno = created.json() as { id: string };

    const res = await post(`/api/members/${bruno.id}/invite`, {}, alice.cookies);
    expect(res.statusCode).toBe(201);
    const { inviteCode } = res.json() as { inviteCode: string };
    expect((await get(`/api/auth/invites/${inviteCode}`)).statusCode).toBe(200);

    // Une fois le compte ouvert, l'invitation n'est plus un moyen d'y toucher.
    expect((await post(`/api/auth/invites/${inviteCode}/redeem`, { password: PASSWORD })).statusCode).toBe(200);
    expect((await post(`/api/members/${bruno.id}/invite`, {}, alice.cookies)).statusCode).toBe(409);
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
    expect(ok.statusCode).toBe(200);
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

    // 404 : membre hors du cercle — la ressource est masquée, pas seulement refusée
    const forbidden = await post(
      '/api/reservations',
      { equipmentId: equipment.id, start: '2026-07-10T08:00:00Z', end: '2026-07-10T10:00:00Z' },
      chloe.cookies,
    );
    expect(forbidden.statusCode).toBe(404);

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
    corsApp = await buildTestApp({ corsOrigins: ['https://localhost'] });
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
    expect(refused.statusCode).toBe(404);

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

    // Alice ne peut pas éditer le message de Bruno : 403 (refus assumé) et non 401, qui
    // déconnecterait Alice de l'application pour un simple geste refusé.
    const editOther = await app.inject({
      method: 'PUT',
      url: `/api/messages/${message.id}`,
      payload: { body: 'pirate' },
      cookies: alice.cookies,
    });
    expect(editOther.statusCode).toBe(403);

    // Même règle pour le renommage d'un fil dont on n'est pas l'auteur.
    const renameOther = await app.inject({
      method: 'PUT',
      url: `/api/threads/${thread.id}`,
      payload: { title: 'Détourné' },
      cookies: bruno.cookies,
    });
    expect(renameOther.statusCode).toBe(403);

    // Les messages du fil (1er message + réponse).
    const msgs = await get(`/api/threads/${thread.id}/messages`, alice.cookies);
    expect((msgs.json() as unknown[]).length).toBe(2);

    // Seul l'auteur supprime le fil : Bruno ne peut pas, Alice oui (cascade sur les messages).
    const delByOther = await app.inject({ method: 'DELETE', url: `/api/threads/${thread.id}`, cookies: bruno.cookies });
    expect(delByOther.statusCode).toBe(403);
    const delByAuthor = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${thread.id}`,
      cookies: alice.cookies,
    });
    expect(delByAuthor.statusCode).toBe(204);
    expect(((await get(`/api/equipments/${equipment.id}/threads`, alice.cookies)).json() as unknown[]).length).toBe(0);
  });
});

describe('API — checklists (checklists + points de contrôle)', () => {
  it('crée deux checklists, coche depuis le cercle, remet à zéro ; le hors-cercle est refusé', async () => {
    const { equipment, alice, bruno, chloe } = await setupMembersAndEquipment();

    // Alice crée sa checklist avec ses points ; Bruno la sienne : plusieurs par équipement.
    const created = await post(
      '/api/checklists',
      { equipmentId: equipment.id, title: 'Avant utilisation', itemLabels: ['Niveau d’huile', 'Gasoil'] },
      alice.cookies,
    );
    expect(created.statusCode).toBe(201);
    const checklist = created.json() as { id: string; authorId: string };
    expect(checklist.authorId).toBe(alice.id);
    expect(
      (await post('/api/checklists', { equipmentId: equipment.id, title: 'Hivernage' }, bruno.cookies)).statusCode,
    ).toBe(201);

    // Chloé (hors cercle) ne peut pas créer de checklist.
    const refused = await post('/api/checklists', { equipmentId: equipment.id, title: 'X' }, chloe.cookies);
    expect(refused.statusCode).toBe(404);

    // Liste avec avancement.
    const list = await get(`/api/equipments/${equipment.id}/checklists`, bruno.cookies);
    const summaries = list.json() as { id: string; itemCount: number; checkedCount: number }[];
    expect(summaries).toHaveLength(2);
    expect(summaries.find((s) => s.id === checklist.id)).toMatchObject({ itemCount: 2, checkedCount: 0 });

    // Bruno n'a pas créé la checklist mais fait partie du cercle : il peut y ajouter un point.
    const added = await post('/api/checklist-items', { checklistId: checklist.id, label: 'Chenilles' }, bruno.cookies);
    expect(added.statusCode).toBe(201);
    expect((added.json() as { position: number }).position).toBe(2);

    // Chloé, hors cercle, ne voit rien et ne peut rien ajouter.
    const addedByOutsider = await post(
      '/api/checklist-items',
      { checklistId: checklist.id, label: 'Pirate' },
      chloe.cookies,
    );
    expect(addedByOutsider.statusCode).toBe(404);
    expect((await get(`/api/equipments/${equipment.id}/checklists`, chloe.cookies)).statusCode).toBe(404);
    expect((await get(`/api/checklists/${checklist.id}/items`, chloe.cookies)).statusCode).toBe(404);

    // Cocher est également ouvert à tout le cercle.
    const items = (await get(`/api/checklists/${checklist.id}/items`, bruno.cookies)).json() as { id: string }[];
    expect(items).toHaveLength(3);
    const checked = await app.inject({
      method: 'PUT',
      url: `/api/checklist-items/${items[0]!.id}`,
      payload: { checked: true },
      cookies: bruno.cookies,
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toMatchObject({ checkedById: bruno.id });

    // Chloé ne peut pas cocher.
    const checkedByOutsider = await app.inject({
      method: 'PUT',
      url: `/api/checklist-items/${items[1]!.id}`,
      payload: { checked: true },
      cookies: chloe.cookies,
    });
    expect(checkedByOutsider.statusCode).toBe(404);

    // Remise à zéro par un membre du cercle.
    expect((await post(`/api/checklists/${checklist.id}/reset`, {}, bruno.cookies)).statusCode).toBe(204);
    const afterReset = (await get(`/api/equipments/${equipment.id}/checklists`, alice.cookies)).json() as {
      id: string;
      checkedCount: number;
    }[];
    expect(afterReset.find((s) => s.id === checklist.id)!.checkedCount).toBe(0);
  });

  it('renomme, supprime un point puis la checklist depuis un membre qui ne l’a pas créée', async () => {
    const { equipment, alice, bruno, chloe } = await setupMembersAndEquipment();
    // Checklist créée par Alice ; c'est Bruno (même cercle) qui la remanie ensuite.
    const checklist = (
      await post(
        '/api/checklists',
        { equipmentId: equipment.id, title: 'Avant utilisation', itemLabels: ['Niveau d’huile'] },
        alice.cookies,
      )
    ).json() as { id: string };
    const item = ((await get(`/api/checklists/${checklist.id}/items`, alice.cookies)).json() as { id: string }[])[0]!;

    const renamed = await app.inject({
      method: 'PUT',
      url: `/api/checklists/${checklist.id}`,
      payload: { title: 'Avant chantier' },
      cookies: bruno.cookies,
    });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as { title: string }).title).toBe('Avant chantier');

    const relabelled = await app.inject({
      method: 'PUT',
      url: `/api/checklist-items/${item.id}`,
      payload: { label: 'Huile moteur' },
      cookies: bruno.cookies,
    });
    expect((relabelled.json() as { label: string }).label).toBe('Huile moteur');

    // Chloé, hors cercle, ne peut ni renommer la checklist ni ses points.
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/checklists/${checklist.id}`,
          payload: { title: 'Pirate' },
          cookies: chloe.cookies,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/checklist-items/${item.id}`,
          payload: { label: 'Pirate' },
          cookies: chloe.cookies,
        })
      ).statusCode,
    ).toBe(404);

    // Un PUT sans libellé ni coche ne veut rien dire.
    const empty = await app.inject({
      method: 'PUT',
      url: `/api/checklist-items/${item.id}`,
      payload: {},
      cookies: alice.cookies,
    });
    expect(empty.statusCode).toBe(400);

    // Suppression : refusée hors cercle, autorisée dans le cercle sans être le créateur.
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/checklist-items/${item.id}`, cookies: chloe.cookies }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/checklist-items/${item.id}`, cookies: bruno.cookies }))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/checklists/${checklist.id}`, cookies: chloe.cookies }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/checklists/${checklist.id}`, cookies: bruno.cookies }))
        .statusCode,
    ).toBe(204);
    expect(((await get(`/api/equipments/${equipment.id}/checklists`, alice.cookies)).json() as unknown[]).length).toBe(
      0,
    );
  });
});

describe('API — cloisonnement par cercle (aucune fuite hors du cercle)', () => {
  /** Un équipement Alice+Bruno garni de données de chaque type ; Chloé reste dehors. */
  async function fullyLoadedEquipment() {
    const ctx = await setupMembersAndEquipment();
    const { equipment, alice } = ctx;
    const reservation = (
      await post(
        '/api/reservations',
        { equipmentId: equipment.id, start: '2026-07-10T08:00:00Z', end: '2026-07-10T12:00:00Z' },
        alice.cookies,
      )
    ).json() as { id: string };
    await post('/api/usage', { equipmentId: equipment.id, meterReading: 100, isMaintenance: true }, alice.cookies);
    await post('/api/usage', { equipmentId: equipment.id, meterReading: 200 }, alice.cookies);
    const expense = (
      await post(
        '/api/expenses',
        {
          equipmentId: equipment.id,
          label: 'Plein',
          amountEuros: 90,
          payerId: alice.id,
          date: '2026-07-01',
          category: 'FUEL',
          split: { type: 'EQUAL' },
        },
        alice.cookies,
      )
    ).json() as { id: string };
    const thread = (
      await post('/api/threads', { equipmentId: equipment.id, title: 'Panne', body: 'Détails' }, alice.cookies)
    ).json() as { id: string };
    const checklist = (
      await post(
        '/api/checklists',
        { equipmentId: equipment.id, title: 'Avant utilisation', itemLabels: ['Huile'] },
        alice.cookies,
      )
    ).json() as { id: string };
    const item = ((await get(`/api/checklists/${checklist.id}/items`, alice.cookies)).json() as { id: string }[])[0]!;
    return { ...ctx, reservation, expense, thread, checklist, item };
  }

  it('masque en 404 toutes les routes rattachées à un équipement, en lecture comme en écriture', async () => {
    const f = await fullyLoadedEquipment();
    const e = f.equipment.id;

    // Chaque route équipement, avec la session d'un membre hors du cercle.
    const calls: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; payload?: unknown }[] = [
      // Lectures
      { method: 'GET', url: `/api/equipments/${e}` },
      { method: 'GET', url: `/api/equipments/${e}/reservations` },
      { method: 'GET', url: `/api/equipments/${e}/usage` },
      { method: 'GET', url: `/api/equipments/${e}/maintenance` },
      { method: 'GET', url: `/api/equipments/${e}/expenses` },
      { method: 'GET', url: `/api/equipments/${e}/reimbursements` },
      { method: 'GET', url: `/api/equipments/${e}/balances` },
      { method: 'GET', url: `/api/equipments/${e}/settlement` },
      { method: 'GET', url: `/api/equipments/${e}/threads` },
      { method: 'GET', url: `/api/threads/${f.thread.id}/messages` },
      { method: 'GET', url: `/api/equipments/${e}/checklists` },
      { method: 'GET', url: `/api/checklists/${f.checklist.id}/items` },
      // Écritures
      { method: 'PUT', url: `/api/equipments/${e}`, payload: { name: 'Pirate' } },
      { method: 'DELETE', url: `/api/equipments/${e}` },
      {
        method: 'POST',
        url: '/api/reservations',
        payload: { equipmentId: e, start: '2026-08-01T08:00:00Z', end: '2026-08-01T10:00:00Z' },
      },
      {
        method: 'POST',
        url: '/api/reservations/recurring',
        payload: {
          equipmentId: e,
          start: '2026-08-01T08:00:00Z',
          end: '2026-08-01T10:00:00Z',
          frequency: 'WEEKLY',
          until: '2026-08-15',
        },
      },
      { method: 'PUT', url: `/api/reservations/${f.reservation.id}`, payload: { notes: 'pirate' } },
      { method: 'DELETE', url: `/api/reservations/${f.reservation.id}` },
      { method: 'POST', url: '/api/usage', payload: { equipmentId: e, meterReading: 300 } },
      {
        method: 'POST',
        url: '/api/expenses',
        payload: {
          equipmentId: e,
          label: 'Pirate',
          amountEuros: 10,
          payerId: f.alice.id,
          date: '2026-07-02',
          category: 'OTHER',
          split: { type: 'EQUAL' },
        },
      },
      { method: 'DELETE', url: `/api/expenses/${f.expense.id}` },
      {
        method: 'POST',
        url: '/api/reimbursements',
        payload: {
          equipmentId: e,
          fromMemberId: f.bruno.id,
          toMemberId: f.alice.id,
          amountEuros: 5,
          date: '2026-07-02',
        },
      },
      { method: 'POST', url: '/api/threads', payload: { equipmentId: e, title: 'Pirate' } },
      { method: 'POST', url: '/api/messages', payload: { threadId: f.thread.id, body: 'Pirate' } },
      { method: 'POST', url: '/api/checklists', payload: { equipmentId: e, title: 'Pirate' } },
      { method: 'POST', url: `/api/checklists/${f.checklist.id}/reset`, payload: {} },
      { method: 'POST', url: '/api/checklist-items', payload: { checklistId: f.checklist.id, label: 'Pirate' } },
      { method: 'PUT', url: `/api/checklist-items/${f.item.id}`, payload: { checked: true } },
    ];

    for (const call of calls) {
      const res = await app.inject({
        method: call.method,
        url: call.url,
        payload: call.payload as Record<string, unknown> | undefined,
        cookies: f.chloe.cookies,
      });
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(404);
      // Aucun indice sur l'existence de la ressource dans le corps.
      expect((res.json() as { error: string }).error, `${call.method} ${call.url}`).toMatch(/introuvable/i);
    }

    // Rien n'a été détruit au passage : l'équipement et ses données sont intacts.
    expect((await get(`/api/equipments/${e}`, f.alice.cookies)).statusCode).toBe(200);
    expect(((await get(`/api/equipments/${e}/reservations`, f.alice.cookies)).json() as unknown[]).length).toBe(1);
    expect(((await get(`/api/equipments/${e}/expenses`, f.alice.cookies)).json() as unknown[]).length).toBe(1);
  });

  it('cadre les vues globales sur le périmètre du demandeur', async () => {
    const f = await fullyLoadedEquipment();

    // Vues transverses : pas d'erreur, mais rien du cercle des autres.
    for (const url of ['/api/equipments', '/api/calendar', '/api/alerts', `/api/members/${f.alice.id}/usage`]) {
      const res = await get(url, f.chloe.cookies);
      expect(res.statusCode, url).toBe(200);
      expect(res.json(), url).toEqual([]);
    }

    // Les membres du cercle, eux, voient tout.
    expect(((await get('/api/equipments', f.bruno.cookies)).json() as unknown[]).length).toBe(1);
    expect(((await get('/api/calendar', f.bruno.cookies)).json() as unknown[]).length).toBe(1);
    expect(((await get('/api/alerts', f.bruno.cookies)).json() as unknown[]).length).toBe(1);
    expect(((await get(`/api/members/${f.alice.id}/usage`, f.bruno.cookies)).json() as unknown[]).length).toBe(2);
  });

  it('rend une réponse indiscernable entre ressource inexistante et ressource d’un autre cercle', async () => {
    const f = await fullyLoadedEquipment();
    // Un identifiant qui n'existe nulle part, à comparer aux identifiants réels d'un autre cercle.
    const INCONNU = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const paires: { réel: string; inexistant: string }[] = [
      { réel: `/api/equipments/${f.equipment.id}`, inexistant: `/api/equipments/${INCONNU}` },
      {
        réel: `/api/equipments/${f.equipment.id}/checklists`,
        inexistant: `/api/equipments/${INCONNU}/checklists`,
      },
      { réel: `/api/threads/${f.thread.id}/messages`, inexistant: `/api/threads/${INCONNU}/messages` },
      { réel: `/api/checklists/${f.checklist.id}/items`, inexistant: `/api/checklists/${INCONNU}/items` },
    ];

    for (const { réel, inexistant } of paires) {
      const surRéel = await get(réel, f.chloe.cookies);
      const surInexistant = await get(inexistant, f.chloe.cookies);
      // Même code et même forme de message : l'identifiant seul change, comme pour un vrai 404.
      expect(surRéel.statusCode, réel).toBe(surInexistant.statusCode);
      const attendu = (surInexistant.json() as { error: string }).error.replace(INCONNU, '<id>');
      const obtenu = (surRéel.json() as { error: string }).error
        .replace(f.equipment.id, '<id>')
        .replace(f.thread.id, '<id>')
        .replace(f.checklist.id, '<id>');
      expect(obtenu, réel).toBe(attendu);
    }

    // Écritures : même masquage, y compris sur les gestes réservés à l'auteur (qui répondaient 401).
    const écritures: { method: 'PUT' | 'DELETE'; réel: string; inexistant: string; payload?: unknown }[] = [
      {
        method: 'PUT',
        réel: `/api/threads/${f.thread.id}`,
        inexistant: `/api/threads/${INCONNU}`,
        payload: { title: 'Pirate' },
      },
      { method: 'DELETE', réel: `/api/threads/${f.thread.id}`, inexistant: `/api/threads/${INCONNU}` },
      {
        method: 'DELETE',
        réel: `/api/reservations/${f.reservation.id}`,
        inexistant: `/api/reservations/${INCONNU}`,
      },
      { method: 'DELETE', réel: `/api/expenses/${f.expense.id}`, inexistant: `/api/expenses/${INCONNU}` },
      {
        method: 'PUT',
        réel: `/api/checklist-items/${f.item.id}`,
        inexistant: `/api/checklist-items/${INCONNU}`,
        payload: { checked: true },
      },
    ];

    for (const { method, réel, inexistant, payload } of écritures) {
      const surRéel = await app.inject({
        method,
        url: réel,
        payload: payload as Record<string, unknown> | undefined,
        cookies: f.chloe.cookies,
      });
      const surInexistant = await app.inject({
        method,
        url: inexistant,
        payload: payload as Record<string, unknown> | undefined,
        cookies: f.chloe.cookies,
      });
      expect(surRéel.statusCode, `${method} ${réel}`).toBe(404);
      expect(surRéel.statusCode, `${method} ${réel}`).toBe(surInexistant.statusCode);
      const attendu = (surInexistant.json() as { error: string }).error.replace(INCONNU, '<id>');
      const obtenu = (surRéel.json() as { error: string }).error
        .replace(f.thread.id, '<id>')
        .replace(f.reservation.id, '<id>')
        .replace(f.expense.id, '<id>')
        .replace(f.item.id, '<id>');
      expect(obtenu, `${method} ${réel}`).toBe(attendu);
    }

    // Rien n'a été modifié ni supprimé par ces sondages.
    expect((await get(`/api/threads/${f.thread.id}/messages`, f.alice.cookies)).statusCode).toBe(200);
    expect(
      ((await get(`/api/equipments/${f.equipment.id}/expenses`, f.alice.cookies)).json() as unknown[]).length,
    ).toBe(1);
  });

  it('masque aussi la notification d’un autre membre', async () => {
    const { equipment, alice, bruno, chloe } = await setupMembersAndEquipment();
    await post('/api/threads', { equipmentId: equipment.id, title: 'Sujet' }, alice.cookies);
    const notif = ((await get('/api/notifications', bruno.cookies)).json() as { id: string }[])[0]!;
    const INCONNU = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

    const surRéelle = await post(`/api/notifications/${notif.id}/read`, {}, chloe.cookies);
    const surInexistante = await post(`/api/notifications/${INCONNU}/read`, {}, chloe.cookies);
    expect(surRéelle.statusCode).toBe(404);
    expect(surRéelle.statusCode).toBe(surInexistante.statusCode);
    expect((surRéelle.json() as { error: string }).error.replace(notif.id, '<id>')).toBe(
      (surInexistante.json() as { error: string }).error.replace(INCONNU, '<id>'),
    );
    // Elle est restée non lue pour son destinataire.
    expect(((await get('/api/notifications/unread-count', bruno.cookies)).json() as { count: number }).count).toBe(1);
  });

  it('refuse de créer un équipement dont on ne fait pas partie', async () => {
    const { alice, bruno } = await setupMembersAndEquipment();
    const res = await post(
      '/api/equipments',
      {
        name: 'Remorque fantôme',
        category: 'Transport',
        acquisitionDate: '2026-01-15',
        purchaseValueEuros: 1200,
        meterUnit: 'KILOMETERS',
        memberIds: [bruno.id],
        maintenanceThreshold: null,
      },
      alice.cookies,
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('API — cloisonnement des comptes (annuaire, invitations, sessions)', () => {
  const NATIVE = { 'x-sharemate-client': 'native' };

  /** Noms de l'annuaire tel que le voit ce demandeur, triés pour comparaison. */
  async function annuaire(cookies: Cookies): Promise<string[]> {
    const res = await get('/api/members', cookies);
    expect(res.statusCode).toBe(200);
    return (res.json() as { name: string }[]).map((m) => m.name).sort();
  }

  it('la prise de contrôle d’un compte échoue dès sa première étape', async () => {
    // Chaîne d'attaque : lire l'annuaire → obtenir un code d'invitation pour la cible → le
    // consommer avec un mot de passe choisi. Chloé, hors du cercle d'Alice, tente le parcours.
    const { alice, bruno, chloe } = await setupMembersAndEquipment();

    // 1. L'annuaire ne livre plus l'identifiant des membres hors de son périmètre.
    const vus = (await get('/api/members', chloe.cookies)).json() as { id: string }[];
    expect(vus.map((m) => m.id)).toEqual([chloe.id]);

    // 2. Même en connaissant les identifiants, la régénération est refusée — masquée en 404,
    //    du message exact qu'aurait produit un membre inexistant.
    for (const cible of [alice.id, bruno.id]) {
      const res = await post(`/api/members/${cible}/invite`, {}, chloe.cookies);
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: string }).error).toBe(`Membre introuvable : ${cible}`);
    }

    // 3. Aucun code n'a été émis, et les comptes visés sont intacts.
    expect((await post('/api/auth/login', { identifier: 'Alice', password: PASSWORD })).statusCode).toBe(200);
    expect((await post('/api/auth/login', { identifier: 'Bruno', password: PASSWORD })).statusCode).toBe(200);
  });

  it('une invitation ne réinitialise jamais un compte déjà ouvert', async () => {
    const alice = await bootstrapAlice();
    const bruno = await inviteAndRedeem('Bruno', alice.cookies);
    // Alice partage le cercle de Bruno : elle est dans son périmètre, et pourtant refusée.
    const res = await post(`/api/members/${bruno.id}/invite`, {}, alice.cookies);
    expect(res.statusCode).toBe(409);
    expect((await post('/api/auth/login', { identifier: 'Bruno', password: PASSWORD })).statusCode).toBe(200);
  });

  it('journalise en warn une invitation régénérée pour un autre membre', async () => {
    const lignes: string[] = [];
    const tracé = await buildTestApp({
      logger: { level: 'warn', stream: { write: (l: string) => void lignes.push(l) } },
    });
    const bootstrap = await tracé.inject({
      method: 'POST',
      url: '/api/auth/bootstrap',
      payload: { name: 'Alice', password: PASSWORD },
    });
    const cookies = sessionCookie(bootstrap);
    const créé = await tracé.inject({ method: 'POST', url: '/api/members', payload: { name: 'Bruno' }, cookies });
    const bruno = créé.json() as { id: string };

    await tracé.inject({ method: 'POST', url: `/api/members/${bruno.id}/invite`, payload: {}, cookies });

    const trace = lignes.find((l) => l.includes('invitation régénérée pour un autre membre'));
    expect(trace).toBeDefined();
    expect(trace).toContain(bruno.id);
    await tracé.close();
  });

  it('cadre l’annuaire sur le périmètre du demandeur, invités compris', async () => {
    const { alice, bruno, chloe } = await setupMembersAndEquipment();
    // Alice voit son cercle (Bruno) et Chloé, qu'elle a invitée sans cercle commun.
    expect(await annuaire(alice.cookies)).toEqual(['Alice', 'Bruno', 'Chloé']);
    // Bruno voit son cercle, et rien de plus : Chloé lui est inconnue.
    expect(await annuaire(bruno.cookies)).toEqual(['Alice', 'Bruno']);
    expect(await annuaire(chloe.cookies)).toEqual(['Chloé']);
  });

  it('n’expose l’email d’un membre qu’à l’intérieur de son périmètre', async () => {
    const alice = await bootstrapAlice();
    const chloe = await inviteAndRedeem('Chloé', alice.cookies);
    await post('/api/members', { name: 'Denis', email: 'denis@example.test' }, alice.cookies);

    expect(JSON.stringify((await get('/api/members', alice.cookies)).json())).toContain('denis@example.test');
    expect(JSON.stringify((await get('/api/members', chloe.cookies)).json())).not.toContain('denis@example.test');
  });

  it('tout membre d’un cercle reste visible de ce cercle (noms affichés par le front)', async () => {
    const { equipment, alice, bruno, chloe } = await setupMembersAndEquipment();
    const ajout = await app.inject({
      method: 'PUT',
      url: `/api/equipments/${equipment.id}`,
      payload: { memberIds: [alice.id, bruno.id, chloe.id] },
      cookies: alice.cookies,
    });
    expect(ajout.statusCode).toBe(200);

    // Le calendrier, les dépenses, les discussions et les checklists n'affichent que des membres
    // du cercle : chacun d'eux doit pouvoir être nommé par chacun des autres.
    for (const cookies of [alice.cookies, bruno.cookies, chloe.cookies]) {
      expect(await annuaire(cookies)).toEqual(['Alice', 'Bruno', 'Chloé']);
    }
  });

  it('l’annuaire signale qui n’a pas encore ouvert son compte', async () => {
    const alice = await bootstrapAlice();
    await post('/api/members', { name: 'Bruno' }, alice.cookies);
    const vus = (await get('/api/members', alice.cookies)).json() as { name: string; hasPassword: boolean }[];
    expect(vus.map((m) => [m.name, m.hasPassword])).toEqual([
      ['Alice', true],
      ['Bruno', false],
    ]);
  });

  it('changer de mot de passe révoque les autres sessions et remplace la sienne', async () => {
    const alice = await bootstrapAlice();
    const autreAppareil = sessionCookie(await post('/api/auth/login', { identifier: 'Alice', password: PASSWORD }));

    const res = await post(
      '/api/auth/password',
      { currentPassword: PASSWORD, newPassword: 'nouveau-mdp' },
      alice.cookies,
    );
    expect(res.statusCode).toBe(200);

    // L'autre appareil est expulsé, l'ancien cookie du demandeur aussi…
    expect((await get('/api/equipments', autreAppareil)).statusCode).toBe(401);
    expect((await get('/api/equipments', alice.cookies)).statusCode).toBe(401);
    // …mais la réponse en a posé un neuf : le geste ne déconnecte pas son auteur.
    expect((await get('/api/equipments', sessionCookie(res))).statusCode).toBe(200);
  });

  it('changer de mot de passe en natif rend un nouveau jeton Bearer', async () => {
    await bootstrapAlice();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'Alice', password: PASSWORD },
      headers: NATIVE,
    });
    const ancien = (login.json() as { token: string }).token;

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { currentPassword: PASSWORD, newPassword: 'nouveau-mdp' },
      headers: { ...NATIVE, authorization: `Bearer ${ancien}` },
    });
    expect(res.statusCode).toBe(200);
    const nouveau = (res.json() as { token: string }).token;
    expect(nouveau).not.toBe(ancien);

    const avecAncien = await app.inject({
      method: 'GET',
      url: '/api/equipments',
      headers: { authorization: `Bearer ${ancien}` },
    });
    const avecNouveau = await app.inject({
      method: 'GET',
      url: '/api/equipments',
      headers: { authorization: `Bearer ${nouveau}` },
    });
    expect(avecAncien.statusCode).toBe(401);
    expect(avecNouveau.statusCode).toBe(200);
  });

  it('un lien d’invitation périme au bout de 7 jours', async () => {
    const horloge = new FixedClock(new Date('2026-07-02T10:00:00Z'));
    const daté = await buildTestApp({ clock: horloge });
    const bootstrap = await daté.inject({
      method: 'POST',
      url: '/api/auth/bootstrap',
      payload: { name: 'Alice', password: PASSWORD },
    });
    const créé = await daté.inject({
      method: 'POST',
      url: '/api/members',
      payload: { name: 'Bruno' },
      cookies: sessionCookie(bootstrap),
    });
    const { inviteCode } = créé.json() as { inviteCode: string };

    horloge.set(new Date('2026-07-09T09:59:59Z'));
    expect((await daté.inject({ method: 'GET', url: `/api/auth/invites/${inviteCode}` })).statusCode).toBe(200);

    horloge.set(new Date('2026-07-09T10:00:01Z'));
    expect((await daté.inject({ method: 'GET', url: `/api/auth/invites/${inviteCode}` })).statusCode).toBe(404);
    const redeem = await daté.inject({
      method: 'POST',
      url: `/api/auth/invites/${inviteCode}/redeem`,
      payload: { password: PASSWORD },
    });
    expect(redeem.statusCode).toBe(404);
    await daté.close();
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
