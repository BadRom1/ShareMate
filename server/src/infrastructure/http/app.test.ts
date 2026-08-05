import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDatabase } from '../persistence/sqlite/database.js';
import {
  SqliteChecklistItemRepository,
  SqliteChecklistRepository,
  SqliteCredentialRepository,
  SqliteDeviceTokenRepository,
  SqliteDocumentRepository,
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
  SqliteSubEquipmentRepository,
  SqliteUsageRecordRepository,
} from '../persistence/sqlite/repositories.js';
import { CryptoTokenGenerator, ScryptPasswordHasher, SystemClock, UuidGenerator } from '../tech/adapters.js';
import { FixedClock } from '../../application/testing/in-memory.js';
import { buildApp } from './app.js';
import { ReceiptStorage } from '../tech/receipt-storage.js';
import { DOCUMENT_PREFIX, RICH_CONTENT_TYPES } from '../tech/document-storage.js';
import { ATTACHMENT_PREFIX } from '../tech/attachment-storage.js';
import { MediaStorage } from '../tech/object-store.js';
import type { ObjectStore } from '../tech/object-store.js';
import { DEFAULT_RATE_LIMITS } from './rate-limit.js';
import type { AppDependencies } from './app.js';
import crypto from 'node:crypto';
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
    subEquipments: new SqliteSubEquipmentRepository(db),
    reservations: new SqliteReservationRepository(db),
    usageRecords: new SqliteUsageRecordRepository(db),
    expenses: new SqliteExpenseRepository(db),
    reimbursements: new SqliteReimbursementRepository(db),
    threads: new SqliteThreadRepository(db),
    messages: new SqliteMessageRepository(db),
    checklists: new SqliteChecklistRepository(db),
    checklistItems: new SqliteChecklistItemRepository(db),
    documents: new SqliteDocumentRepository(db),
    notifications: new SqliteNotificationRepository(db),
    notificationPreferences: new SqliteNotificationPreferenceRepository(db),
    pushSubscriptions: new SqlitePushSubscriptionRepository(db),
    deviceTokens: new SqliteDeviceTokenRepository(db),
    credentials: new SqliteCredentialRepository(db),
    sessions: new SqliteSessionRepository(db),
    // Coût de dérivation réduit : ces parcours ouvrent des dizaines de sessions, et au coût de
    // production (N = 2¹⁷, ~0,3 s par hachage) la suite se paierait plusieurs minutes de scrypt.
    // Le coût réel est testé pour lui-même dans tech/adapters.test.ts.
    passwordHasher: new ScryptPasswordHasher({ N: 2 ** 12, r: 8, p: 1 }),
    tokenGenerator: new CryptoTokenGenerator(),
    idGenerator: new UuidGenerator(),
    clock: new SystemClock(),
    // Les parcours d'intégration enchaînent des dizaines de requêtes depuis la même « IP » :
    // les plafonds sont relevés ici, et testés pour eux-mêmes sur une app dédiée (voir plus bas).
    rateLimits: { global: 10_000, auth: 10_000, sensitive: 10_000, anonymousRead: 10_000 },
    ...overrides,
  });
}

beforeEach(async () => {
  app = await buildTestApp();
});

afterEach(async () => {
  await app.close();
});

// `target` : les parcours qui ont besoin d'un répertoire d'upload tournent sur une app dédiée.
async function post(url: string, body: unknown, cookies?: Cookies, target: FastifyInstance = app) {
  return target.inject({ method: 'POST', url, payload: body as Record<string, unknown>, cookies });
}

async function get(url: string, cookies?: Cookies, target: FastifyInstance = app) {
  return target.inject({ method: 'GET', url, cookies });
}

function sessionCookie(res: { cookies: { name: string; value: string }[] }): Cookies {
  const cookie = res.cookies.find((c) => c.name === 'sharemate_session');
  if (!cookie) throw new Error('Cookie de session absent de la réponse.');
  return { sharemate_session: cookie.value };
}

/** Premier compte (Alice) via bootstrap : renvoie son id et sa session. */
async function bootstrapAlice(target: FastifyInstance = app) {
  const res = await post('/api/auth/bootstrap', { name: 'Alice', password: PASSWORD }, undefined, target);
  expect(res.statusCode).toBe(201);
  return { id: (res.json() as { member: { id: string } }).member.id, cookies: sessionCookie(res) };
}

/** Crée un membre (invité), consomme son invitation et renvoie id + session. */
async function inviteAndRedeem(name: string, creatorCookies: Cookies, target: FastifyInstance = app) {
  const created = await post('/api/members', { name }, creatorCookies, target);
  expect(created.statusCode).toBe(201);
  const { id, inviteCode } = created.json() as { id: string; inviteCode: string };
  const redeemed = await post(`/api/auth/invites/${inviteCode}/redeem`, { password: PASSWORD }, undefined, target);
  expect(redeemed.statusCode).toBe(200);
  return { id, cookies: sessionCookie(redeemed) };
}

/** Équipement minimal, dont le cercle est passé tel quel (les valeurs métier n'importent pas ici). */
async function createEquipment(name: string, memberIds: string[], cookies: Cookies, target: FastifyInstance = app) {
  return post(
    '/api/equipments',
    {
      name,
      category: 'BTP',
      acquisitionDate: '2025-01-01',
      purchaseValueEuros: 1000,
      meterUnit: 'HOURS',
      memberIds,
      maintenanceThreshold: null,
    },
    cookies,
    target,
  );
}

/** Trois membres connectés ; la minipelle porte le cercle m1/m2, m3 reste en dehors. */
async function setupMembersAndEquipment(target: FastifyInstance = app) {
  const alice = await bootstrapAlice(target);
  const bruno = await inviteAndRedeem('Bruno', alice.cookies, target);
  const chloe = await inviteAndRedeem('Chloé', alice.cookies, target);
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
    target,
  );
  const equipment = equipmentRes.json() as { id: string; memberIds: string[] };
  return { equipment, alice, bruno, chloe };
}

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

describe('API — justificatifs et front statique', () => {
  let staticApp: FastifyInstance;
  let uploadsDir: string;
  let webDistDir: string;
  let tmpRoot: string;

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

  /** Téléverse un justificatif et le rattache à une dépense de `equipmentId`. */
  async function dépenseAvecJustificatif(equipmentId: string, payerId: string, cookies: Cookies) {
    const contenu = Buffer.from(`justificatif-${equipmentId}`);
    const { payload, headers } = filePayload('recu.png', contenu);
    const upload = await staticApp.inject({ method: 'POST', url: '/api/uploads/receipts', payload, headers, cookies });
    expect(upload.statusCode).toBe(201);
    const { path: servedPath } = upload.json() as { path: string };
    expect(servedPath).toMatch(/^\/uploads\/[\w-]+\.png$/);
    const dépense = await post(
      '/api/expenses',
      {
        equipmentId,
        label: 'Plein gasoil',
        amountEuros: 90,
        payerId,
        date: '2026-07-01',
        category: 'FUEL',
        split: { type: 'EQUAL' },
        receiptPath: servedPath,
      },
      cookies,
      staticApp,
    );
    expect(dépense.statusCode).toBe(201);
    const fichier = path.join(uploadsDir, servedPath.slice('/uploads/'.length));
    return { id: (dépense.json() as { id: string }).id, servedPath, contenu, fichier };
  }

  it('téléverse un justificatif, puis ne le sert qu’avec une session', async () => {
    const { equipment, alice } = await setupMembersAndEquipment(staticApp);
    const { servedPath, contenu } = await dépenseAvecJustificatif(equipment.id, alice.id, alice.cookies);

    const authentifié = await staticApp.inject({ method: 'GET', url: servedPath, cookies: alice.cookies });
    expect(authentifié.statusCode).toBe(200);
    expect(authentifié.rawPayload.equals(contenu)).toBe(true);
    // Un justificatif ne doit pas survivre sur l'appareil à la perte du droit qui l'ouvre.
    expect(authentifié.headers['cache-control']).toBe('private, no-store');

    // Sans session, le justificatif reste inaccessible.
    const anonyme = await staticApp.inject({ method: 'GET', url: servedPath });
    expect(anonyme.statusCode).toBe(401);
  });

  it('ne sert un justificatif qu’aux membres du cercle de la dépense qui le porte', async () => {
    const { equipment, alice, chloe } = await setupMembersAndEquipment(staticApp);
    // Chloé a son propre cercle : session valide, mais étrangère à la minipelle.
    const tondeuse = await post(
      '/api/equipments',
      {
        name: 'Tondeuse',
        category: 'Jardin',
        acquisitionDate: '2025-03-01',
        purchaseValueEuros: 900,
        meterUnit: 'HOURS',
        memberIds: [chloe.id],
        maintenanceThreshold: null,
      },
      chloe.cookies,
      staticApp,
    );
    expect(tondeuse.statusCode).toBe(201);

    // Réponse de référence : le justificatif n'existe pas encore, ce chemin ne désigne rien.
    const servedPath = `/uploads/${crypto.randomUUID()}.png`;
    const avant = await get(servedPath, chloe.cookies, staticApp);
    expect(avant.statusCode).toBe(404);

    const justificatif = await dépenseAvecJustificatif(equipment.id, alice.id, alice.cookies);
    const membre = await get(justificatif.servedPath, alice.cookies, staticApp);
    expect(membre.statusCode).toBe(200);

    // Le même chemin, vu de l'extérieur du cercle : la réponse est celle d'un fichier qui n'existe
    // pas — même code, même corps. Détenir le chemin n'apprend donc rien (anti-énumération).
    const après = await get(justificatif.servedPath, chloe.cookies, staticApp);
    expect(après.statusCode).toBe(avant.statusCode);
    expect(après.payload).toBe(avant.payload.replace(servedPath, justificatif.servedPath));
  });

  it('purge le fichier quand la dépense qui le porte est supprimée', async () => {
    const { equipment, alice } = await setupMembersAndEquipment(staticApp);
    const { id, fichier, servedPath } = await dépenseAvecJustificatif(equipment.id, alice.id, alice.cookies);
    expect(fs.existsSync(fichier)).toBe(true);

    const suppression = await staticApp.inject({
      method: 'DELETE',
      url: `/api/expenses/${id}`,
      cookies: alice.cookies,
    });
    expect(suppression.statusCode).toBe(204);
    expect(fs.existsSync(fichier)).toBe(false);
    expect((await get(servedPath, alice.cookies, staticApp)).statusCode).toBe(404);
  });

  it('purge les justificatifs emportés par la suppression de l’équipement', async () => {
    const { equipment, alice } = await setupMembersAndEquipment(staticApp);
    const { fichier } = await dépenseAvecJustificatif(equipment.id, alice.id, alice.cookies);

    const suppression = await staticApp.inject({
      method: 'DELETE',
      url: `/api/equipments/${equipment.id}`,
      cookies: alice.cookies,
    });
    expect(suppression.statusCode).toBe(204);
    expect(fs.existsSync(fichier)).toBe(false);
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

    // Une route d'API inconnue est un 404 JSON, avec ou sans session : aucune route n'ayant été
    // appariée, il n'y a rien à protéger — la garde de session vit dans les plugins de domaine.
    expect((await staticApp.inject({ method: 'GET', url: '/api/inconnu' })).statusCode).toBe(404);
    const api = await staticApp.inject({ method: 'GET', url: '/api/inconnu', cookies });
    expect(api.statusCode).toBe(404);
    expect((api.json() as { error: string }).error).toBeTruthy();
  });

  it('un chemin encodé ne contourne pas la garde de session', async () => {
    await session(); // l'instance est amorcée : seule la session manque
    // Le routeur décode le pourcentage avant d'apparier, l'URL brute non : décider de
    // l'authentification sur `request.raw.url` laissait `/%61pi/...` atteindre le handler.
    const { payload, headers } = filePayload('recu.png', Buffer.from('charge-utile-anonyme'));
    const dépôt = await staticApp.inject({ method: 'POST', url: '/%61pi/uploads/receipts', payload, headers });
    expect(dépôt.statusCode, `corps : ${dépôt.body}`).toBe(401);
    // Aucun octet écrit : le remplissage de disque anonyme passait par là.
    expect(fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : []).toEqual([]);

    const encodées: [string, string, unknown][] = [
      ['GET', '/%61pi/members', undefined],
      ['GET', '/a%70i/notifications', undefined],
      ['DELETE', '/%61pi/notifications/subscriptions', { endpoint: 'https://push.example.test/abonnement' }],
      ['DELETE', '/%61pi/notifications/device-tokens', { token: 'jeton-alice' }],
      ['GET', '/%75ploads/00000000-0000-4000-8000-000000000000.png', undefined],
    ];
    for (const [method, url, body] of encodées) {
      const res = await staticApp.inject({ method: method as 'GET', url, payload: body as Record<string, unknown> });
      expect(res.statusCode, `${method} ${url} → ${res.body}`).toBe(401);
    }
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
    // Plafonds de production : ceux de `buildTestApp` sont relevés pour les parcours d'intégration.
    const bridée = await buildTestApp({ rateLimits: DEFAULT_RATE_LIMITS });
    const tentative = () =>
      bridée.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { identifier: 'Personne', password: 'xxxxxxxx' },
      });
    try {
      for (let i = 0; i < DEFAULT_RATE_LIMITS.auth; i++) {
        expect((await tentative()).statusCode).toBe(401);
      }
      const coupée = await tentative();
      expect(coupée.statusCode).toBe(429);
      expect((coupée.json() as { error: string }).error).toMatch(/^Trop de requêtes\./);
    } finally {
      await bridée.close();
    }
  });

  it('une requête anonyme sur une route protégée est plafonnée elle aussi', async () => {
    // Le plafond du greffon s'attache au niveau de la route, donc après les hooks de contexte :
    // la garde de session rendait 401 avant que le compteur ne s'incrémente, et marteler une
    // route protégée sans cookie ne coûtait rien à personne. Le plafond global est désormais posé
    // en `onRequest` à la racine, avant l'authentification.
    const bridée = await buildTestApp({ rateLimits: { ...DEFAULT_RATE_LIMITS, global: 5 } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) {
        codes.push((await get('/api/equipments', undefined, bridée)).statusCode);
      }
      expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(codes.slice(5)).toEqual([429, 429]);
    } finally {
      await bridée.close();
    }
  });

  it('le changement de mot de passe est plafonné comme les routes d’authentification', async () => {
    // Deux scrypt à N=2^17 par appel : la session ne suffit pas à protéger la machine, seul le
    // plafond le fait. Sans lui, la route resterait sous le global, cent fois plus haut.
    const bridée = await buildTestApp({ rateLimits: DEFAULT_RATE_LIMITS });
    try {
      const alice = await bootstrapAlice(bridée);
      const tentative = () =>
        bridée.inject({
          method: 'POST',
          url: '/api/auth/password',
          payload: { currentPassword: 'mauvais-mot-de-passe', newPassword: 'nouveau-motdepasse' },
          cookies: alice.cookies,
        });
      // Le compteur est propre à la route : le bootstrap qui précède ne l'a pas entamé.
      for (let i = 0; i < DEFAULT_RATE_LIMITS.auth; i++) {
        expect((await tentative()).statusCode).toBe(401);
      }
      expect((await tentative()).statusCode).toBe(429);
    } finally {
      await bridée.close();
    }
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

    // `memberId` n'appartient pas au schéma de la route : il est refusé net, et non plus
    // accepté puis silencieusement écrasé — un appelant ne doit pas croire son auteur retenu.
    const usurpation = await post(
      '/api/reservations',
      {
        equipmentId: equipment.id,
        memberId: alice.id,
        start: '2026-07-10T08:00:00Z',
        end: '2026-07-10T10:00:00Z',
      },
      bruno.cookies,
    );
    expect(usurpation.statusCode).toBe(400);

    const res = await post(
      '/api/reservations',
      { equipmentId: equipment.id, start: '2026-07-10T08:00:00Z', end: '2026-07-10T10:00:00Z' },
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

describe('API — sous-équipements (contenu du lot)', () => {
  it('compose le lot, le corrige depuis tout le cercle, et le refuse au-dehors', async () => {
    const { equipment, alice, bruno, chloe } = await setupMembersAndEquipment();

    const remorque = await post(
      '/api/sub-equipments',
      { equipmentId: equipment.id, name: 'Remorque', notes: 'Plaque AB-123-CD' },
      alice.cookies,
    );
    expect(remorque.statusCode).toBe(201);
    expect(remorque.json()).toMatchObject({ name: 'Remorque', quantity: 1, position: 0 });

    // Bruno, membre du cercle sans avoir rien saisi jusqu'ici, complète le lot.
    const godets = await post(
      '/api/sub-equipments',
      { equipmentId: equipment.id, name: 'Godets', quantity: 3, notes: '30, 60, 90 cm' },
      bruno.cookies,
    );
    expect(godets.statusCode).toBe(201);
    expect((godets.json() as { position: number }).position).toBe(1);

    const lot = (await get(`/api/equipments/${equipment.id}/sub-equipments`, alice.cookies)).json() as {
      id: string;
      name: string;
      quantity: number;
    }[];
    expect(lot.map((s) => s.name)).toEqual(['Remorque', 'Godets']);

    // Corriger et retirer sont ouverts à tout le cercle, quel qu'ait été l'auteur de la saisie.
    const corrigé = await app.inject({
      method: 'PUT',
      url: `/api/sub-equipments/${(godets.json() as { id: string }).id}`,
      payload: { quantity: 4, notes: null },
      cookies: alice.cookies,
    });
    expect(corrigé.statusCode).toBe(200);
    expect(corrigé.json()).toMatchObject({ name: 'Godets', quantity: 4, notes: null });

    // Chloé, hors cercle : le lot n'existe pas pour elle, en lecture comme en écriture.
    expect((await get(`/api/equipments/${equipment.id}/sub-equipments`, chloe.cookies)).statusCode).toBe(404);
    expect(
      (await post('/api/sub-equipments', { equipmentId: equipment.id, name: 'Pirate' }, chloe.cookies)).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/sub-equipments/${(remorque.json() as { id: string }).id}`,
          payload: { name: 'Pirate' },
          cookies: chloe.cookies,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/sub-equipments/${(remorque.json() as { id: string }).id}`,
          cookies: chloe.cookies,
        })
      ).statusCode,
    ).toBe(404);

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/sub-equipments/${(remorque.json() as { id: string }).id}`,
          cookies: bruno.cookies,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      ((await get(`/api/equipments/${equipment.id}/sub-equipments`, alice.cookies)).json() as unknown[]).length,
    ).toBe(1);
  });

  it('refuse une quantité fractionnaire ou nulle, et une modification vide', async () => {
    const { equipment, alice } = await setupMembersAndEquipment();
    for (const quantity of [0, 1.5]) {
      const refused = await post(
        '/api/sub-equipments',
        { equipmentId: equipment.id, name: 'Godets', quantity },
        alice.cookies,
      );
      expect(refused.statusCode).toBe(400);
    }
    const créé = await post('/api/sub-equipments', { equipmentId: equipment.id, name: 'Godets' }, alice.cookies);
    const vide = await app.inject({
      method: 'PUT',
      url: `/api/sub-equipments/${(créé.json() as { id: string }).id}`,
      payload: {},
      cookies: alice.cookies,
    });
    expect(vide.statusCode).toBe(400);
  });

  it('le lot disparaît avec l’équipement', async () => {
    // Il n'accompagne plus rien : la cascade de la persistance l'emporte, sans laisser de rangée
    // rattachée à un équipement qui n'existe plus.
    const { equipment, alice } = await setupMembersAndEquipment();
    await post('/api/sub-equipments', { equipmentId: equipment.id, name: 'Remorque' }, alice.cookies);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/equipments/${equipment.id}`, cookies: alice.cookies }))
        .statusCode,
    ).toBe(204);
    expect((await get(`/api/equipments/${equipment.id}/sub-equipments`, alice.cookies)).statusCode).toBe(404);
  });
});

describe('API — refus de téléversement rendus en français', () => {
  let filesApp: FastifyInstance;
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharemate-refus-'));
    filesApp = await buildTestApp({
      documentsDir: path.join(tmpRoot, 'documents'),
      attachmentsDir: path.join(tmpRoot, 'attachments'),
    });
  });

  afterEach(async () => {
    await filesApp.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function multipart(champs: Record<string, string>, contenu: Uint8Array, filename = 'gros.pdf') {
    const boundary = '----sharemateRefusBoundary';
    const morceaux: Uint8Array[] = Object.entries(champs).map(([nom, valeur]) =>
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${nom}"\r\n\r\n${valeur}\r\n`),
    );
    morceaux.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: application/pdf\r\n\r\n`,
      ),
      contenu,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    );
    return {
      payload: Buffer.concat(morceaux),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  }

  /** Un peu plus que le plafond du greffon multipart (25 Mo). */
  function tropGros() {
    return Buffer.alloc(26 * 1024 * 1024, 0x41);
  }

  // Sans cette traduction, c'est le seul message anglais que l'API rend jamais : le greffon
  // multipart échoue pendant la lecture du flux, donc avant tout code applicatif.
  it('refuse un document trop lourd en français', async () => {
    const { equipment, alice } = await setupMembersAndEquipment(filesApp);
    const { payload, headers } = multipart({ equipmentId: equipment.id, category: 'MANUAL' }, tropGros());

    const res = await filesApp.inject({
      method: 'POST',
      url: '/api/documents/file',
      payload,
      headers,
      cookies: alice.cookies,
    });

    expect(res.statusCode).toBe(413);
    expect((res.json() as { error: string }).error).toBe('Fichier trop lourd (25 Mo maximum).');
  });

  it('refuse une pièce jointe trop lourde en français', async () => {
    const { equipment, alice } = await setupMembersAndEquipment(filesApp);
    const fil = await post('/api/threads', { equipmentId: equipment.id, title: 'Panne' }, alice.cookies, filesApp);
    const { id: threadId } = fil.json() as { id: string };
    const { payload, headers } = multipart({ threadId }, tropGros());

    const res = await filesApp.inject({
      method: 'POST',
      url: '/api/messages/file',
      payload,
      headers,
      cookies: alice.cookies,
    });

    expect(res.statusCode).toBe(413);
    expect((res.json() as { error: string }).error).toBe('Fichier trop lourd (25 Mo maximum).');
  });

  // Ignoré, un champ démesuré se serait déguisé en autre chose : un `name` trop long serait
  // devenu « pas de nom », un `equipmentId` trop long « champ obligatoire ».
  it('refuse un champ multipart démesuré plutôt que de l’ignorer', async () => {
    const { equipment, alice } = await setupMembersAndEquipment(filesApp);
    const { payload, headers } = multipart(
      { equipmentId: equipment.id, category: 'MANUAL', name: 'x'.repeat(10_001) },
      Buffer.from('%PDF'),
    );

    const res = await filesApp.inject({
      method: 'POST',
      url: '/api/documents/file',
      payload,
      headers,
      cookies: alice.cookies,
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/« name » dépasse 10000 caractères/);
  });
});

describe('API — place partagée entre le dossier et les discussions', () => {
  let filesApp: FastifyInstance;
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharemate-place-'));
    filesApp = await buildTestApp({
      documentsDir: path.join(tmpRoot, 'documents'),
      attachmentsDir: path.join(tmpRoot, 'attachments'),
    });
  });

  afterEach(async () => {
    await filesApp.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Le plafond vaut pour l'équipement, pas pour le dossier seul : sinon les messages seraient la
  // façon la moins chère de remplir le bucket.
  it('une pièce jointe consomme la place du dossier, et réciproquement', async () => {
    const { equipment, alice } = await setupMembersAndEquipment(filesApp);
    const fil = await post('/api/threads', { equipmentId: equipment.id, title: 'Panne' }, alice.cookies, filesApp);
    const { id: threadId } = fil.json() as { id: string };

    // Une pièce jointe de 1 Mo, puis un document : les deux passent par le même compteur.
    const boundary = '----sharematePlaceBoundary';
    const corps = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="threadId"\r\n\r\n${threadId}\r\n`),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="panne.png"\r\n` +
          `Content-Type: image/png\r\n\r\n`,
      ),
      Buffer.alloc(1024 * 1024, 0x41),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const jointe = await filesApp.inject({
      method: 'POST',
      url: '/api/messages/file',
      payload: corps,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      cookies: alice.cookies,
    });
    expect(jointe.statusCode).toBe(201);

    // Le compteur du dossier voit désormais ce mégaoctet : c'est la même enveloppe.
    const documents = await get(`/api/equipments/${equipment.id}/documents`, alice.cookies, filesApp);
    expect(documents.json()).toEqual([]);
    expect(fs.readdirSync(path.join(tmpRoot, 'attachments'))).toHaveLength(1);
  });
});

describe('API — pièces jointes des discussions', () => {
  let filesApp: FastifyInstance;
  let attachmentsDir: string;
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharemate-jointes-'));
    attachmentsDir = path.join(tmpRoot, 'attachments');
    filesApp = await buildTestApp({ attachmentsDir });
  });

  afterEach(async () => {
    await filesApp.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Corps multipart : champs puis fichier. */
  function corps(champs: Record<string, string>, filename = 'panne.png', contenu = Buffer.from('PNGPANNE')) {
    const boundary = '----sharemateAttachmentBoundary';
    const morceaux = Object.entries(champs).map(([nom, valeur]) =>
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${nom}"\r\n\r\n${valeur}\r\n`),
    );
    morceaux.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: image/png\r\n\r\n`,
      ),
      contenu,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    );
    return {
      payload: Buffer.concat(morceaux),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  }

  async function joindre(champs: Record<string, string>, cookies: Cookies, filename = 'panne.png') {
    const { payload, headers } = corps(champs, filename);
    return filesApp.inject({ method: 'POST', url: '/api/messages/file', payload, headers, cookies });
  }

  /** Fil ouvert par Alice sur un équipement partagé avec Bruno. */
  async function unFil() {
    const contexte = await setupMembersAndEquipment(filesApp);
    const fil = await post(
      '/api/threads',
      { equipmentId: contexte.equipment.id, title: 'Panne moteur' },
      contexte.alice.cookies,
      filesApp,
    );
    expect(fil.statusCode).toBe(201);
    return { ...contexte, thread: fil.json() as { id: string } };
  }

  function objetsStockés(): string[] {
    return fs.existsSync(attachmentsDir) ? fs.readdirSync(attachmentsDir) : [];
  }

  it('joint un fichier à un message, le sert au cercle, puis le supprime avec lui', async () => {
    const { thread, alice, bruno, chloe } = await unFil();

    const posté = await joindre({ threadId: thread.id, body: 'Regardez ce bruit' }, alice.cookies);
    expect(posté.statusCode).toBe(201);
    const message = posté.json() as Record<string, unknown>;
    expect(message.attachment).toEqual({ fileName: 'panne.png', contentType: 'image/png', sizeBytes: 8 });
    // La clé de l'objet ne sort jamais de l'API : le contenu se lit par l'identifiant du message.
    expect(JSON.stringify(message)).not.toContain('attachments/');
    expect(objetsStockés()).toHaveLength(1);

    const contenu = await get(`/api/messages/${message.id}/attachment`, bruno.cookies, filesApp);
    expect(contenu.statusCode).toBe(200);
    expect(contenu.body).toBe('PNGPANNE');
    expect(contenu.headers['content-type']).toBe('image/png');
    expect(contenu.headers['cache-control']).toBe('private, no-store');

    // Chloé est hors du cercle : le message n'existe pas pour elle.
    expect((await get(`/api/messages/${message.id}/attachment`, chloe.cookies, filesApp)).statusCode).toBe(404);

    const supprimé = await filesApp.inject({
      method: 'DELETE',
      url: `/api/messages/${message.id}`,
      cookies: alice.cookies,
    });
    expect(supprimé.statusCode).toBe(204);
    expect(objetsStockés()).toEqual([]);
  });

  it('accepte un message sans texte quand un fichier l’accompagne', async () => {
    const { thread, alice } = await unFil();
    const posté = await joindre({ threadId: thread.id }, alice.cookies);
    expect(posté.statusCode).toBe(201);
    expect((posté.json() as { body: string }).body).toBe('');
  });

  // Le corps d'une édition peut être vidé, mais seulement d'un message qui porte un fichier : le
  // schéma laisse passer la chaîne vide, le domaine tranche — lui seul voit la pièce jointe.
  it('laisse vider le texte d’un message qui porte un fichier, jamais celui d’un autre', async () => {
    const { thread, alice } = await unFil();
    const avecFichier = (await joindre({ threadId: thread.id, body: 'Regardez' }, alice.cookies)).json() as {
      id: string;
    };
    const texteSeul = (
      await post('/api/messages', { threadId: thread.id, body: 'Texte seul' }, alice.cookies, filesApp)
    ).json() as { id: string };

    const vidé = await filesApp.inject({
      method: 'PUT',
      url: `/api/messages/${avecFichier.id}`,
      payload: { body: '' },
      cookies: alice.cookies,
    });
    expect(vidé.statusCode).toBe(200);
    expect(vidé.json()).toMatchObject({ body: '', attachment: { fileName: 'panne.png' } });

    const refusé = await filesApp.inject({
      method: 'PUT',
      url: `/api/messages/${texteSeul.id}`,
      payload: { body: '   ' },
      cookies: alice.cookies,
    });
    expect(refusé.statusCode).toBe(400);
    expect((refusé.json() as { error: string }).error).toBe('Le message ne peut pas être vide.');
  });

  it('joint un fichier à une réponse, dans le bon sous-fil', async () => {
    const { thread, alice, bruno } = await unFil();
    const racine = await post(
      '/api/messages',
      { threadId: thread.id, body: 'Quelqu’un a une photo ?' },
      alice.cookies,
      filesApp,
    );
    const parentId = (racine.json() as { id: string }).id;

    const réponse = await joindre({ threadId: thread.id, body: 'La voilà', parentId }, bruno.cookies);
    expect(réponse.statusCode).toBe(201);
    expect((réponse.json() as { parentId: string }).parentId).toBe(parentId);
  });

  // Supprimer un message emporte ses réponses : leurs fichiers doivent partir avec elles.
  it('purge les pièces jointes des réponses emportées', async () => {
    const { thread, alice, bruno } = await unFil();
    const racine = await joindre({ threadId: thread.id, body: 'Le bruit' }, alice.cookies);
    const parentId = (racine.json() as { id: string }).id;
    expect((await joindre({ threadId: thread.id, body: 'Idem', parentId }, bruno.cookies)).statusCode).toBe(201);
    expect(objetsStockés()).toHaveLength(2);

    await filesApp.inject({ method: 'DELETE', url: `/api/messages/${parentId}`, cookies: alice.cookies });

    expect(objetsStockés()).toEqual([]);
  });

  it('purge les pièces jointes quand le fil entier est supprimé', async () => {
    const { thread, alice } = await unFil();
    expect((await joindre({ threadId: thread.id, body: 'Le bruit' }, alice.cookies)).statusCode).toBe(201);

    await filesApp.inject({ method: 'DELETE', url: `/api/threads/${thread.id}`, cookies: alice.cookies });

    expect(objetsStockés()).toEqual([]);
  });

  it('purge les pièces jointes quand l’équipement est supprimé', async () => {
    const { thread, equipment, alice } = await unFil();
    expect((await joindre({ threadId: thread.id, body: 'Le bruit' }, alice.cookies)).statusCode).toBe(201);

    const supprimé = await filesApp.inject({
      method: 'DELETE',
      url: `/api/equipments/${equipment.id}`,
      cookies: alice.cookies,
    });
    expect(supprimé.statusCode).toBe(204);
    expect(objetsStockés()).toEqual([]);
  });

  it('refuse un format non géré et le hors-cercle, sans rien écrire', async () => {
    const { thread, alice, chloe } = await unFil();
    expect((await joindre({ threadId: thread.id }, alice.cookies, 'page.html')).statusCode).toBe(400);
    expect((await joindre({ threadId: thread.id }, chloe.cookies)).statusCode).toBe(404);
    expect((await joindre({}, alice.cookies)).statusCode).toBe(400);
    expect(objetsStockés()).toEqual([]);
  });

  it('un message sans pièce jointe n’a pas de contenu à servir', async () => {
    const { thread, alice } = await unFil();
    const sansFichier = await post(
      '/api/messages',
      { threadId: thread.id, body: 'Texte seul' },
      alice.cookies,
      filesApp,
    );
    const { id } = sansFichier.json() as { id: string };
    expect((await get(`/api/messages/${id}/attachment`, alice.cookies, filesApp)).statusCode).toBe(404);
  });

  it('sans stockage configuré, la pièce jointe n’est pas offerte et les messages restent en texte', async () => {
    const { equipment, alice } = await setupMembersAndEquipment();
    const fil = await post('/api/threads', { equipmentId: equipment.id, title: 'Panne' }, alice.cookies);
    const { id: threadId } = fil.json() as { id: string };
    const { payload, headers } = corps({ threadId });

    const refusé = await app.inject({
      method: 'POST',
      url: '/api/messages/file',
      payload,
      headers,
      cookies: alice.cookies,
    });
    expect(refusé.statusCode).toBe(404);

    const texte = await post('/api/messages', { threadId, body: 'Texte seul' }, alice.cookies);
    expect(texte.statusCode).toBe(201);
    expect((texte.json() as { attachment: unknown }).attachment).toBeNull();
  });
});

describe('API — stockage dans un bucket (justificatifs et documents)', () => {
  let bucketApp: FastifyInstance;

  /**
   * Magasin qui se comporte comme un bucket : il garde les octets en mémoire et rend une URL
   * signée au lieu d'un flux. Aucun réseau — c'est la décision « rediriger plutôt que servir »
   * qui est testée ici, la signature elle-même l'étant dans tech/object-store.test.ts.
   */
  class MagasinFactice implements ObjectStore {
    readonly objets = new Map<string, Buffer>();
    async exists(key: string) {
      return this.objets.has(key);
    }
    async put(key: string, content: Buffer) {
      this.objets.set(key, content);
    }
    async signedUrl(key: string, _contentType: string, disposition: string, ttlSeconds: number) {
      return `https://bucket.exemple/${key}?expire=${ttlSeconds}&disposition=${encodeURIComponent(disposition)}`;
    }
    async read() {
      return null;
    }
    async remove(key: string) {
      this.objets.delete(key);
    }
  }

  let magasin: MagasinFactice;

  beforeEach(async () => {
    magasin = new MagasinFactice();
    bucketApp = await buildTestApp({
      receiptStorage: new ReceiptStorage(magasin),
      documentStorage: new MediaStorage(magasin, { keyPrefix: DOCUMENT_PREFIX, contentTypes: RICH_CONTENT_TYPES }),
      attachmentStorage: new MediaStorage(magasin, { keyPrefix: ATTACHMENT_PREFIX, contentTypes: RICH_CONTENT_TYPES }),
    });
  });

  afterEach(async () => {
    await bucketApp.close();
  });

  it('redirige vers une URL signée plutôt que de servir le justificatif', async () => {
    const { equipment, alice } = await setupMembersAndEquipment(bucketApp);
    const { payload, headers } = filePayload('recu.png', Buffer.from('le reçu'));
    const upload = await bucketApp.inject({
      method: 'POST',
      url: '/api/uploads/receipts',
      payload,
      headers,
      cookies: alice.cookies,
    });
    expect(upload.statusCode).toBe(201);
    const { path: receiptPath } = upload.json() as { path: string };
    // Le chemin public n'a pas changé de forme : les dépenses existantes restent valides.
    expect(receiptPath).toMatch(/^\/uploads\/[\w-]+\.png$/);
    // L'objet, lui, est rangé sous son propre préfixe dans le bucket.
    expect([...magasin.objets.keys()]).toEqual([`receipts/${receiptPath.slice('/uploads/'.length)}`]);

    const dépense = await post(
      '/api/expenses',
      {
        equipmentId: equipment.id,
        label: 'Plein gasoil',
        amountEuros: 90,
        payerId: alice.id,
        date: '2026-03-02',
        category: 'FUEL',
        split: { type: 'EQUAL' },
        receiptPath,
      },
      alice.cookies,
      bucketApp,
    );
    expect(dépense.statusCode).toBe(201);

    const lecture = await get(receiptPath, alice.cookies, bucketApp);
    expect(lecture.statusCode).toBe(302);
    expect(lecture.headers.location).toContain(`receipts/${receiptPath.slice('/uploads/'.length)}`);
    expect(lecture.headers['cache-control']).toBe('private, no-store');
    // Le corps du justificatif ne transite pas par l'API : c'est le bucket qui le servira.
    expect(lecture.body).not.toContain('le reçu');
  });

  it('la redirection reste refusée hors du cercle', async () => {
    const { equipment, alice, chloe } = await setupMembersAndEquipment(bucketApp);
    const { payload, headers } = filePayload('recu.png', Buffer.from('le reçu'));
    const upload = await bucketApp.inject({
      method: 'POST',
      url: '/api/uploads/receipts',
      payload,
      headers,
      cookies: alice.cookies,
    });
    const { path: receiptPath } = upload.json() as { path: string };
    await post(
      '/api/expenses',
      {
        equipmentId: equipment.id,
        label: 'Plein gasoil',
        amountEuros: 90,
        payerId: alice.id,
        date: '2026-03-02',
        category: 'FUEL',
        split: { type: 'EQUAL' },
        receiptPath,
      },
      alice.cookies,
      bucketApp,
    );

    // Détenir le chemin ne suffit pas : la signature n'est émise qu'après le contrôle du cercle.
    const refusée = await get(receiptPath, chloe.cookies, bucketApp);
    expect(refusée.statusCode).toBe(404);
    expect(refusée.headers.location).toBeUndefined();
  });

  it('redirige aussi pour le contenu d’un document', async () => {
    const { equipment, alice } = await setupMembersAndEquipment(bucketApp);
    const boundary = '----sharemateBucketBoundary';
    const corps = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="equipmentId"\r\n\r\n${equipment.id}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\nMANUAL\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="manuel.pdf"\r\n` +
          `Content-Type: application/pdf\r\n\r\n`,
      ),
      Buffer.from('%PDF-1.4'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const déposé = await bucketApp.inject({
      method: 'POST',
      url: '/api/documents/file',
      payload: corps,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      cookies: alice.cookies,
    });
    expect(déposé.statusCode).toBe(201);
    const { id } = déposé.json() as { id: string };

    const contenu = await get(`/api/documents/${id}/content`, alice.cookies, bucketApp);
    expect(contenu.statusCode).toBe(302);
    expect(contenu.headers.location).toContain('documents/');
    // Le nom d'origine voyage dans l'URL signée : le bucket ne connaît que l'UUID de la clé.
    expect(decodeURIComponent(String(contenu.headers.location))).toContain('manuel.pdf');
    expect(contenu.headers['cache-control']).toBe('private, no-store');
  });

  it('purge l’objet du bucket à la suppression de la dépense', async () => {
    const { equipment, alice } = await setupMembersAndEquipment(bucketApp);
    const { payload, headers } = filePayload('recu.png', Buffer.from('le reçu'));
    const upload = await bucketApp.inject({
      method: 'POST',
      url: '/api/uploads/receipts',
      payload,
      headers,
      cookies: alice.cookies,
    });
    const { path: receiptPath } = upload.json() as { path: string };
    const dépense = await post(
      '/api/expenses',
      {
        equipmentId: equipment.id,
        label: 'Plein gasoil',
        amountEuros: 90,
        payerId: alice.id,
        date: '2026-03-02',
        category: 'FUEL',
        split: { type: 'EQUAL' },
        receiptPath,
      },
      alice.cookies,
      bucketApp,
    );
    expect(magasin.objets.size).toBe(1);

    const supprimée = await bucketApp.inject({
      method: 'DELETE',
      url: `/api/expenses/${(dépense.json() as { id: string }).id}`,
      cookies: alice.cookies,
    });
    expect(supprimée.statusCode).toBe(204);
    // Sans cette purge, l'objet resterait facturé alors que plus rien ne le nomme.
    expect(magasin.objets.size).toBe(0);
  });
});

describe('API — documents (dossier d’un équipement)', () => {
  /**
   * Corps multipart bâti partie par partie : un champ peut précéder ou suivre le fichier, et la
   * route doit lire les deux — c'est ce que fait un `FormData` selon l'ordre des `append`.
   */
  type Part = { field: string; value: string } | { filename: string; content: Buffer; contentType?: string };

  function multipartBody(parts: Part[]) {
    const boundary = '----sharemateDocumentBoundary';
    const chunks: Buffer[] = [];
    for (const part of parts) {
      if ('field' in part) {
        chunks.push(
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"\r\n\r\n${part.value}\r\n`),
        );
      } else {
        chunks.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${part.filename}"\r\n` +
              `Content-Type: ${part.contentType ?? 'application/pdf'}\r\n\r\n`,
          ),
          part.content,
          Buffer.from('\r\n'),
        );
      }
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
  }

  describe('liens (aucun stockage requis)', () => {
    it('dépose un lien, le liste, le renomme et le supprime — depuis tout le cercle', async () => {
      const { equipment, alice, bruno, chloe } = await setupMembersAndEquipment();

      const created = await post(
        '/api/documents',
        { equipmentId: equipment.id, url: 'https://kubota-eu.com/pieces', name: 'Catalogue', category: 'OTHER' },
        alice.cookies,
      );
      expect(created.statusCode).toBe(201);
      const document = created.json() as { id: string; kind: string; authorId: string; url: string };
      expect(document).toMatchObject({
        kind: 'LINK',
        authorId: alice.id,
        url: 'https://kubota-eu.com/pieces',
        fileName: null,
        sizeBytes: null,
      });

      // Le dossier appartient au cercle : Bruno, qui n'a rien déposé, renomme et reclasse.
      const renamed = await app.inject({
        method: 'PUT',
        url: `/api/documents/${document.id}`,
        payload: { name: 'Pièces détachées', category: 'MAINTENANCE' },
        cookies: bruno.cookies,
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({ name: 'Pièces détachées', category: 'MAINTENANCE' });

      const list = await get(`/api/equipments/${equipment.id}/documents`, bruno.cookies);
      expect((list.json() as { id: string }[]).map((d) => d.id)).toEqual([document.id]);

      // Chloé est hors du cercle : le dossier n'existe pas pour elle.
      expect((await get(`/api/equipments/${equipment.id}/documents`, chloe.cookies)).statusCode).toBe(404);
      expect(
        (
          await post(
            '/api/documents',
            { equipmentId: equipment.id, url: 'https://pirate.fr', category: 'OTHER' },
            chloe.cookies,
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: 'DELETE', url: `/api/documents/${document.id}`, cookies: chloe.cookies }))
          .statusCode,
      ).toBe(404);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${document.id}`,
        cookies: bruno.cookies,
      });
      expect(deleted.statusCode).toBe(204);
      expect((await get(`/api/equipments/${equipment.id}/documents`, alice.cookies)).json()).toEqual([]);
    });

    it('nomme le lien d’après son domaine quand aucun nom n’est saisi', async () => {
      const { equipment, alice } = await setupMembersAndEquipment();
      const created = await post(
        '/api/documents',
        { equipmentId: equipment.id, url: 'https://www.youtube.com/watch?v=abc', category: 'MANUAL' },
        alice.cookies,
      );
      expect((created.json() as { name: string }).name).toBe('www.youtube.com');
    });

    // Le lien est rendu cliquable pour tout le cercle : un schéma exécutable y ferait passer du
    // code dans la session de celui qui clique.
    it('refuse une adresse qui n’est pas http(s)', async () => {
      const { equipment, alice } = await setupMembersAndEquipment();
      for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'pas une url']) {
        const res = await post('/api/documents', { equipmentId: equipment.id, url, category: 'OTHER' }, alice.cookies);
        expect(res.statusCode).toBe(400);
      }
    });

    it('un lien n’a pas de contenu à servir', async () => {
      const { equipment, alice } = await setupMembersAndEquipment();
      const created = await post(
        '/api/documents',
        { equipmentId: equipment.id, url: 'https://exemple.fr', category: 'OTHER' },
        alice.cookies,
      );
      const { id } = created.json() as { id: string };
      // Sans stockage configuré, la route de contenu n'existe pas du tout sur cette app.
      expect((await get(`/api/documents/${id}/content`, alice.cookies)).statusCode).toBe(404);
    });

    it('sans stockage configuré, le dépôt de fichier n’est pas offert', async () => {
      const { equipment, alice } = await setupMembersAndEquipment();
      const { payload, headers } = multipartBody([
        { filename: 'manuel.pdf', content: Buffer.from('%PDF-1.4') },
        { field: 'equipmentId', value: equipment.id },
        { field: 'category', value: 'MANUAL' },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/documents/file',
        payload,
        headers,
        cookies: alice.cookies,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('fichiers (stockage sur disque)', () => {
    let filesApp: FastifyInstance;
    let documentsDir: string;
    let tmpRoot: string;

    beforeEach(async () => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharemate-documents-'));
      documentsDir = path.join(tmpRoot, 'documents');
      filesApp = await buildTestApp({ documentsDir });
    });

    afterEach(async () => {
      await filesApp.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    /** Dépose un fichier dans le dossier de `equipmentId`, champs d'abord. */
    async function déposer(
      equipmentId: string,
      cookies: Cookies,
      options: { filename?: string; contenu?: Buffer; name?: string; category?: string } = {},
    ) {
      const { payload, headers } = multipartBody([
        { field: 'equipmentId', value: equipmentId },
        { field: 'category', value: options.category ?? 'MANUAL' },
        ...(options.name ? [{ field: 'name', value: options.name }] : []),
        { filename: options.filename ?? 'manuel.pdf', content: options.contenu ?? Buffer.from('%PDF-1.4 manuel') },
      ]);
      return filesApp.inject({ method: 'POST', url: '/api/documents/file', payload, headers, cookies });
    }

    /** Fichiers réellement présents dans le répertoire de stockage. */
    function objetsStockés(): string[] {
      return fs.existsSync(documentsDir) ? fs.readdirSync(documentsDir) : [];
    }

    it('dépose un fichier, le sert au cercle, puis le supprime avec son objet', async () => {
      const { equipment, alice, bruno, chloe } = await setupMembersAndEquipment(filesApp);

      const déposé = await déposer(equipment.id, alice.cookies, { name: 'Manuel KX027' });
      expect(déposé.statusCode).toBe(201);
      const document = déposé.json() as Record<string, unknown>;
      expect(document).toMatchObject({
        kind: 'FILE',
        name: 'Manuel KX027',
        fileName: 'manuel.pdf',
        contentType: 'application/pdf',
        sizeBytes: '%PDF-1.4 manuel'.length,
        url: null,
        authorId: alice.id,
      });
      // La clé de l'objet ne sort jamais de l'API : le contenu se lit par l'identifiant du document.
      expect(JSON.stringify(document)).not.toContain('documents/');
      expect(objetsStockés()).toHaveLength(1);

      const contenu = await get(`/api/documents/${document.id}/content`, bruno.cookies, filesApp);
      expect(contenu.statusCode).toBe(200);
      expect(contenu.body).toBe('%PDF-1.4 manuel');
      expect(contenu.headers['content-type']).toBe('application/pdf');
      expect(contenu.headers['cache-control']).toBe('private, no-store');
      expect(contenu.headers['content-disposition']).toContain('manuel.pdf');

      // Chloé est hors du cercle : ni la liste, ni le contenu.
      expect((await get(`/api/documents/${document.id}/content`, chloe.cookies, filesApp)).statusCode).toBe(404);

      const supprimé = await filesApp.inject({
        method: 'DELETE',
        url: `/api/documents/${document.id}`,
        cookies: bruno.cookies,
      });
      expect(supprimé.statusCode).toBe(204);
      // La ligne part avec la requête ; l'objet, lui, n'est atteint que par la purge.
      expect(objetsStockés()).toEqual([]);
    });

    it('lit les champs multipart quel que soit leur rang par rapport au fichier', async () => {
      const { equipment, alice } = await setupMembersAndEquipment(filesApp);
      const { payload, headers } = multipartBody([
        { filename: 'notice.pdf', content: Buffer.from('%PDF') },
        { field: 'equipmentId', value: equipment.id },
        { field: 'category', value: 'MAINTENANCE' },
      ]);
      const res = await filesApp.inject({
        method: 'POST',
        url: '/api/documents/file',
        payload,
        headers,
        cookies: alice.cookies,
      });
      expect(res.statusCode).toBe(201);
      // Faute de nom saisi, celui du fichier fait foi.
      expect(res.json()).toMatchObject({ category: 'MAINTENANCE', name: 'notice.pdf' });
    });

    it('refuse un format non géré sans rien écrire', async () => {
      const { equipment, alice } = await setupMembersAndEquipment(filesApp);
      for (const filename of ['page.html', 'archive.zip', 'script.sh', 'sansextension']) {
        const res = await déposer(equipment.id, alice.cookies, { filename });
        expect(res.statusCode).toBe(400);
      }
      expect(objetsStockés()).toEqual([]);
    });

    it('refuse le dépôt hors du cercle, sans rien écrire', async () => {
      const { equipment, chloe } = await setupMembersAndEquipment(filesApp);
      expect((await déposer(equipment.id, chloe.cookies)).statusCode).toBe(404);
      expect(objetsStockés()).toEqual([]);
    });

    it('refuse une catégorie inconnue sans rien écrire', async () => {
      const { equipment, alice } = await setupMembersAndEquipment(filesApp);
      const res = await déposer(equipment.id, alice.cookies, { category: 'CARTE_GRISE' });
      expect(res.statusCode).toBe(400);
      expect(objetsStockés()).toEqual([]);
    });

    it('supprimer l’équipement emporte le dossier et purge les objets', async () => {
      const { equipment, alice } = await setupMembersAndEquipment(filesApp);
      expect((await déposer(equipment.id, alice.cookies)).statusCode).toBe(201);
      expect(objetsStockés()).toHaveLength(1);

      const supprimé = await filesApp.inject({
        method: 'DELETE',
        url: `/api/equipments/${equipment.id}`,
        cookies: alice.cookies,
      });
      expect(supprimé.statusCode).toBe(204);
      // La cascade efface les rangées ; sans la purge, l'objet resterait facturé à jamais.
      expect(objetsStockés()).toEqual([]);
    });

    it('un document d’un autre cercle ne se lit pas, même son identifiant en main', async () => {
      const { equipment, alice, chloe } = await setupMembersAndEquipment(filesApp);
      const document = (await déposer(equipment.id, alice.cookies)).json() as { id: string };

      // Chloé se dote de son propre équipement : elle a une session valide et un cercle à elle.
      const sien = await createEquipment('Bétonnière', [chloe.id], chloe.cookies, filesApp);
      expect(sien.statusCode).toBe(201);

      const refusé = await get(`/api/documents/${document.id}/content`, chloe.cookies, filesApp);
      expect(refusé.statusCode).toBe(404);
      // Même code et même message qu'un identifiant inexistant : rien ne distingue les deux.
      const inexistant = await get('/api/documents/inconnu/content', chloe.cookies, filesApp);
      expect(inexistant.statusCode).toBe(404);
      expect((refusé.json() as { error: string }).error).toBe(
        (inexistant.json() as { error: string }).error.replace('inconnu', document.id),
      );
    });
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

    // 1. L'annuaire ne livre plus l'identifiant des membres hors de son périmètre : Chloé voit
    //    Alice, qui l'a invitée, et personne d'autre — Bruno lui reste inconnu.
    const vus = (await get('/api/members', chloe.cookies)).json() as { id: string }[];
    expect(vus.map((m) => m.id)).toEqual([alice.id, chloe.id]);

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

  it('la prise de contrôle d’un compte jamais ouvert échoue aussi', async () => {
    // La garde « ce membre a déjà un mot de passe » ne mord pas entre la création d'un compte et
    // sa première connexion : c'est là que la chaîne annuaire → invitation → redeem opérait.
    const alice = await bootstrapAlice();
    const bruno = await inviteAndRedeem('Bruno', alice.cookies);
    const david = (await post('/api/members', { name: 'David' }, alice.cookies)).json() as { id: string };
    // Bruno et David partagent un cercle, et David n'a pas encore de mot de passe.
    await createEquipment('Minipelle', [alice.id, bruno.id, david.id], alice.cookies);
    const privé = (await createEquipment('Broyeur', [alice.id, david.id], alice.cookies)).json() as { id: string };
    expect((await get(`/api/equipments/${privé.id}`, bruno.cookies)).statusCode).toBe(404);

    const invite = await post(`/api/members/${david.id}/invite`, {}, bruno.cookies);
    expect(invite.statusCode).toBe(404);
    expect((invite.json() as { error: string }).error).toBe(`Membre introuvable : ${david.id}`);
    // L'invitant, lui, relance sans difficulté : la relance légitime reste possible.
    expect((await post(`/api/members/${david.id}/invite`, {}, alice.cookies)).statusCode).toBe(201);
  });

  it('un membre ne peut pas s’inscrire un cercle avec quelqu’un hors de son périmètre', async () => {
    // Le périmètre sert de règle d'accès (annuaire, invitations) : s'il s'écrit unilatéralement,
    // il ne borne plus rien — il suffisait de connaître un identifiant pour l'englober.
    const alice = await bootstrapAlice();
    const bruno = await inviteAndRedeem('Bruno', alice.cookies);
    const chloe = await inviteAndRedeem('Chloé', alice.cookies);
    expect(await annuaire(bruno.cookies)).toEqual(['Alice', 'Bruno']);

    const imposé = await createEquipment('Cercle imposé', [bruno.id, chloe.id], bruno.cookies);
    expect(imposé.statusCode).toBe(400);
    expect((imposé.json() as { error: string }).error).toBe(`Membres inconnus : ${chloe.id}`);
    expect(await annuaire(bruno.cookies)).toEqual(['Alice', 'Bruno']);

    // Même refus par modification d'un équipement existant.
    const sien = (await createEquipment('Remorque', [bruno.id], bruno.cookies)).json() as { id: string };
    const ajout = await app.inject({
      method: 'PUT',
      url: `/api/equipments/${sien.id}`,
      payload: { memberIds: [bruno.id, chloe.id] },
      cookies: bruno.cookies,
    });
    expect(ajout.statusCode).toBe(400);
  });

  it('ne dit pas si une adresse hors périmètre est déjà prise', async () => {
    const alice = await bootstrapAlice();
    await post('/api/members', { name: 'Chloé', email: 'chloe@example.test' }, alice.cookies);
    const bruno = await inviteAndRedeem('Bruno', alice.cookies);
    // Bruno ne voit pas Chloé dans l'annuaire : la création d'un membre ne doit pas lui rendre,
    // adresse par adresse, ce que l'annuaire lui refuse.
    expect(await annuaire(bruno.cookies)).toEqual(['Alice', 'Bruno']);
    const sonde = await post('/api/members', { name: 'sonde', email: 'chloe@example.test' }, bruno.cookies);
    expect(sonde.statusCode).toBe(201);

    // Dans son propre périmètre, en revanche, le doublon est signalé : Bruno voit déjà l'adresse.
    const doublon = await post('/api/members', { name: 'sonde', email: 'chloe@example.test' }, bruno.cookies);
    expect(doublon.statusCode).toBe(409);
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
    // Chloé n'a aucun cercle : il lui reste Alice, qui l'a invitée — le lien vaut dans les deux
    // sens, sans quoi elle n'aurait personne à qui ouvrir son premier équipement.
    expect(await annuaire(chloe.cookies)).toEqual(['Alice', 'Chloé']);
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

  it('la prolongation glissante de la session repose le cookie à sa nouvelle échéance', async () => {
    // Sans repose, le cookie garde l'échéance de la connexion : le navigateur l'oublie au bout de
    // 30 jours alors que la session serveur, elle, vient d'être repoussée d'autant.
    const horloge = new FixedClock(new Date('2026-07-02T10:00:00Z'));
    const daté = await buildTestApp({ clock: horloge });
    const alice = await bootstrapAlice(daté);

    // J+2 : l'échéance est lointaine (TTL 30 jours, seuil de prolongation à 10), rien ne bouge.
    horloge.set(new Date('2026-07-04T10:00:00Z'));
    expect((await get('/api/equipments', alice.cookies, daté)).cookies).toEqual([]);

    // J+25 : il reste 5 jours, la session est repoussée — et le cookie avec elle.
    horloge.set(new Date('2026-07-27T10:00:00Z'));
    const posé = (await get('/api/equipments', alice.cookies, daté)).cookies.find(
      (c) => c.name === 'sharemate_session',
    ) as { value: string; expires?: Date } | undefined;
    expect(posé?.value).toBe(alice.cookies.sharemate_session);
    expect(posé?.expires?.toISOString()).toBe('2026-08-26T10:00:00.000Z');
    await daté.close();
  });
});

describe('API — notifications', () => {
  async function openThread(equipmentId: string, cookies: Cookies, target: FastifyInstance = app) {
    const res = await post('/api/threads', { equipmentId, title: 'Sujet' }, cookies, target);
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

  it('un canal push ne se coupe que par son propriétaire', async () => {
    // Les cibles réellement poussées : seul juge de ce qui reste branché.
    const poussés: string[] = [];
    const pushApp = await buildTestApp({
      pushSender: {
        async sendWebPush(subs) {
          poussés.push(...subs.map((s) => s.endpoint));
          return [];
        },
        async sendFcm(tokens) {
          poussés.push(...tokens.map((t) => t.token));
          return [];
        },
      },
    });
    const { equipment, alice, bruno } = await setupMembersAndEquipment(pushApp);
    const endpoint = 'https://push.example.test/abonnement-d-alice';
    const token = 'jeton-d-alice';
    const abonnement = { endpoint, keys: { p256dh: 'p', auth: 'a' } };
    expect((await post('/api/notifications/subscriptions', abonnement, alice.cookies, pushApp)).statusCode).toBe(201);
    expect((await post('/api/notifications/device-tokens', { token }, alice.cookies, pushApp)).statusCode).toBe(201);

    // Bruno connaît l'endpoint et le jeton (ils circulent) : les connaître ne vaut pas le droit.
    // 204 dans les deux cas, pour ne pas faire de la réponse un oracle sur leur existence.
    for (const [url, payload] of [
      ['/api/notifications/subscriptions', { endpoint }],
      ['/api/notifications/device-tokens', { token }],
    ] as const) {
      const res = await pushApp.inject({ method: 'DELETE', url, payload, cookies: bruno.cookies });
      expect(res.statusCode).toBe(204);
    }

    // Alice reçoit toujours ses alertes : ses deux canaux ont survécu à la tentative de Bruno.
    await openThread(equipment.id, bruno.cookies, pushApp);
    expect(poussés).toEqual([endpoint, token]);

    // Alice, elle, coupe bien ses propres canaux.
    poussés.length = 0;
    for (const [url, payload] of [
      ['/api/notifications/subscriptions', { endpoint }],
      ['/api/notifications/device-tokens', { token }],
    ] as const) {
      expect((await pushApp.inject({ method: 'DELETE', url, payload, cookies: alice.cookies })).statusCode).toBe(204);
    }
    await openThread(equipment.id, bruno.cookies, pushApp);
    expect(poussés).toEqual([]);
    await pushApp.close();
  });
});

describe('API — composition du cercle d’un équipement', () => {
  /** Cercle de l'équipement tel que le serveur le renvoie à un membre. */
  async function circle(equipmentId: string, cookies: Cookies): Promise<string[]> {
    const res = await get(`/api/equipments/${equipmentId}`, cookies);
    return (res.json() as { memberIds: string[] }).memberIds;
  }

  it('refuse de se retirer soi-même par une mise à jour de l’équipement', async () => {
    const { equipment, alice, bruno } = await setupMembersAndEquipment();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/equipments/${equipment.id}`,
      payload: { memberIds: [bruno.id] },
      cookies: alice.cookies,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/quitter le cercle/);
    expect(await circle(equipment.id, alice.cookies)).toEqual([alice.id, bruno.id]);
  });

  it('évincer un membre le notifie, et l’équipement disparaît de sa vue', async () => {
    const { equipment, alice, bruno } = await setupMembersAndEquipment();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/equipments/${equipment.id}`,
      payload: { memberIds: [alice.id] },
      cookies: alice.cookies,
    });
    expect(res.statusCode).toBe(200);

    const list = await get('/api/notifications', bruno.cookies);
    const notif = (list.json() as { type: string; body: string }[])[0]!;
    expect(notif.type).toBe('EQUIPMENT_CIRCLE_CHANGED');
    expect(notif.body).toMatch(/vous a retiré du cercle/);
    expect((await get(`/api/equipments/${equipment.id}`, bruno.cookies)).statusCode).toBe(404);
  });

  it('« quitter le cercle » retire le demandeur et prévient ceux qui restent', async () => {
    const { equipment, alice, bruno } = await setupMembersAndEquipment();
    const res = await post(`/api/equipments/${equipment.id}/leave`, {}, bruno.cookies);
    expect(res.statusCode).toBe(204);

    expect(await circle(equipment.id, alice.cookies)).toEqual([alice.id]);
    expect((await get(`/api/equipments/${equipment.id}`, bruno.cookies)).statusCode).toBe(404);
    const list = await get('/api/notifications', alice.cookies);
    expect((list.json() as { type: string; body: string }[])[0]?.body).toMatch(/a quitté le cercle/);
  });

  it('le dernier membre ne peut pas quitter son propre équipement', async () => {
    const { equipment, alice, bruno } = await setupMembersAndEquipment();
    expect((await post(`/api/equipments/${equipment.id}/leave`, {}, bruno.cookies)).statusCode).toBe(204);
    const res = await post(`/api/equipments/${equipment.id}/leave`, {}, alice.cookies);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/dernier membre/);
  });

  it('quitter un équipement hors de son cercle répond 404, comme un identifiant inconnu', async () => {
    const { equipment, chloe } = await setupMembersAndEquipment();
    expect((await post(`/api/equipments/${equipment.id}/leave`, {}, chloe.cookies)).statusCode).toBe(404);
  });
});

describe('API — validation des requêtes (schémas)', () => {
  /** Message d'erreur d'une réponse, tel que le front l'affiche à l'utilisateur. */
  function erreur(res: { json: () => unknown }): string {
    return (res.json() as { error: string }).error;
  }

  const equipmentPayload = (overrides: Record<string, unknown> = {}) => ({
    name: 'Tracteur',
    category: 'Agricole',
    acquisitionDate: '2025-01-01',
    purchaseValueEuros: 30000,
    meterUnit: 'HOURS',
    memberIds: ['remplacé'],
    ...overrides,
  });

  it('refuse un corps absent, vide ou illisible en 400 et en français', async () => {
    // Aucun corps du tout : rien à valider, donc rien d'exploitable côté service.
    const absent = await app.inject({ method: 'POST', url: '/api/auth/login' });
    expect(absent.statusCode).toBe(400);
    expect(erreur(absent)).toMatch(/^Corps de requête invalide/);

    // Corps présent mais vide : le champ obligatoire est nommé.
    const vide = await post('/api/auth/login', {});
    expect(vide.statusCode).toBe(400);
    expect(erreur(vide)).toBe('Corps de requête invalide : le champ « identifier » est obligatoire.');

    // JSON malformé : Fastify échoue avant tout schéma, le message reste français.
    const illisible = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: '{"identifier":',
      headers: { 'content-type': 'application/json' },
    });
    expect(illisible.statusCode).toBe(400);
    expect(erreur(illisible)).toBe('Corps de requête invalide : JSON illisible.');
  });

  it('refuse un champ mal typé, inconnu ou trop long sur les routes d’authentification', async () => {
    const malTypé = await post('/api/auth/login', { identifier: { $ne: null }, password: PASSWORD });
    expect(malTypé.statusCode).toBe(400);
    expect(erreur(malTypé)).toBe('Corps de requête invalide : le champ « identifier » doit être de type texte.');

    const inconnu = await post('/api/auth/login', { identifier: 'Alice', password: PASSWORD, admin: true });
    expect(inconnu.statusCode).toBe(400);
    expect(erreur(inconnu)).toBe('Corps de requête invalide : le champ « admin » n’est pas attendu.');

    const tropLong = await post('/api/auth/login', { identifier: 'x'.repeat(201), password: PASSWORD });
    expect(tropLong.statusCode).toBe(400);
    expect(erreur(tropLong)).toBe('Corps de requête invalide : le champ « identifier » dépasse 200 caractères.');
  });

  it('refuse un équipement incomplet ou hors nomenclature (au lieu d’échouer en 500)', async () => {
    const alice = await bootstrapAlice();

    const incomplet = await post('/api/equipments', { name: 'Tracteur' }, alice.cookies);
    expect(incomplet.statusCode).toBe(400);
    expect(erreur(incomplet)).toBe('Corps de requête invalide : le champ « category » est obligatoire.');

    const unitéInconnue = await post(
      '/api/equipments',
      equipmentPayload({ memberIds: [alice.id], meterUnit: 'PARSECS' }),
      alice.cookies,
    );
    expect(unitéInconnue.statusCode).toBe(400);
    expect(erreur(unitéInconnue)).toBe(
      'Corps de requête invalide : le champ « meterUnit » n’accepte que : HOURS, KILOMETERS.',
    );

    const dateFantaisiste = await post(
      '/api/equipments',
      equipmentPayload({ memberIds: [alice.id], acquisitionDate: 'hier' }),
      alice.cookies,
    );
    expect(dateFantaisiste.statusCode).toBe(400);

    const cercleVide = await post('/api/equipments', equipmentPayload({ memberIds: [] }), alice.cookies);
    expect(cercleVide.statusCode).toBe(400);
  });

  it('refuse une dépense mal formée et n’accepte qu’un justificatif issu de l’upload', async () => {
    const { equipment, alice } = await setupMembersAndEquipment();
    const dépense = (overrides: Record<string, unknown> = {}) => ({
      equipmentId: equipment.id,
      label: 'Gasoil',
      amountEuros: 90,
      payerId: alice.id,
      date: '2026-07-01',
      category: 'FUEL',
      split: { type: 'EQUAL' },
      ...overrides,
    });

    expect((await post('/api/expenses', dépense({ category: 'CAVIAR' }), alice.cookies)).statusCode).toBe(400);
    expect((await post('/api/expenses', dépense({ amountEuros: 'beaucoup' }), alice.cookies)).statusCode).toBe(400);
    expect((await post('/api/expenses', dépense({ split: { type: 'MOITIÉ' } }), alice.cookies)).statusCode).toBe(400);
    // Champ étranger à la forme EQUAL : refusé, et non ignoré en silence.
    const splitHybride = await post(
      '/api/expenses',
      dépense({ split: { type: 'EQUAL', amountsEuros: { [alice.id]: 90 } } }),
      alice.cookies,
    );
    expect(splitHybride.statusCode).toBe(400);

    // Hameçonnage : une URL externe rendue par le front comme un justificatif de l'application.
    const externe = await post(
      '/api/expenses',
      dépense({ receiptPath: 'https://faux-recu.example/facture.pdf' }),
      alice.cookies,
    );
    expect(externe.statusCode).toBe(400);
    expect(erreur(externe)).toBe('Corps de requête invalide : le champ « receiptPath » n’a pas le format attendu.');

    // Chemin relatif hors du répertoire servi : même refus.
    expect(
      (await post('/api/expenses', dépense({ receiptPath: '/uploads/../secret.txt' }), alice.cookies)).statusCode,
    ).toBe(400);

    // Seule la forme réellement produite par POST /api/uploads/receipts est acceptée.
    const valide = await post(
      '/api/expenses',
      dépense({ receiptPath: `/uploads/${crypto.randomUUID()}.png` }),
      alice.cookies,
    );
    expect(valide.statusCode).toBe(201);
  });

  it('refuse des préférences de notification mal typées (au lieu d’échouer en 500)', async () => {
    const alice = await bootstrapAlice();

    const malTypées = await app.inject({
      method: 'PUT',
      url: '/api/notifications/preferences',
      payload: { preferences: 'x' },
      cookies: alice.cookies,
    });
    expect(malTypées.statusCode).toBe(400);
    expect(erreur(malTypées)).toBe('Corps de requête invalide : le champ « preferences » doit être de type liste.');

    const typeInconnu = await app.inject({
      method: 'PUT',
      url: '/api/notifications/preferences',
      payload: { preferences: [{ type: 'PLUIE_DE_GRENOUILLES', inApp: true, push: true }] },
      cookies: alice.cookies,
    });
    expect(typeInconnu.statusCode).toBe(400);
    expect(erreur(typeInconnu)).toMatch(/champ « preferences.0.type »/);
  });

  it('valide aussi les paramètres d’URL et la querystring', async () => {
    const alice = await bootstrapAlice();

    const idInterminable = await get(`/api/equipments/${'x'.repeat(100)}`, alice.cookies);
    expect(idInterminable.statusCode).toBe(400);
    expect(erreur(idInterminable)).toMatch(/^Paramètre d’URL invalide/);

    const filtreInconnu = await get('/api/notifications?unread=oui', alice.cookies);
    expect(filtreInconnu.statusCode).toBe(400);
    expect(erreur(filtreInconnu)).toMatch(/^Paramètre de requête invalide/);
    expect((await get('/api/notifications?unread=1', alice.cookies)).statusCode).toBe(200);

    // Une URL n'est pas maîtrisée par le seul client : anti-cache, `utm_*`, marqueur d'analytics
    // s'y ajoutent sans que l'application les ait demandés. Les ignorer, ne pas refuser la requête.
    expect((await get('/api/notifications?unread=1&_=1234&utm_source=sms', alice.cookies)).statusCode).toBe(200);
  });

  it('refuse une date calendairement impossible (au lieu d’un 500 ou d’une réécriture muette)', async () => {
    const { equipment, alice } = await setupMembersAndEquipment();

    // Le motif du schéma ne porte que la forme : `new Date` rend ici une Invalid Date, qui ne
    // cassait qu'à la sérialisation de la réponse — un 500 déclenchable par un corps de requête.
    for (const absurde of ['0000-00-00', '9999-99-99', '2026-13-01']) {
      const res = await post(
        '/api/equipments',
        equipmentPayload({ memberIds: [alice.id], acquisitionDate: absurde }),
        alice.cookies,
      );
      expect(res.statusCode, `${absurde} → ${res.body}`).toBe(400);
    }
    const dépense = await post(
      '/api/expenses',
      {
        equipmentId: equipment.id,
        label: 'Gasoil',
        amountEuros: 90,
        payerId: alice.id,
        date: '9999-99-99',
        category: 'FUEL',
        split: { type: 'EQUAL' },
      },
      alice.cookies,
    );
    expect(dépense.statusCode, dépense.body).toBe(400);

    // Un jour qui n'existe pas était accepté puis reporté en silence : 2026-02-31 → 3 mars.
    const février = await post(
      '/api/equipments',
      equipmentPayload({ memberIds: [alice.id], acquisitionDate: '2026-02-31' }),
      alice.cookies,
    );
    expect(février.statusCode, février.body).toBe(400);
  });

  it('n’accepte pas `null` là où un nombre est déclaré', async () => {
    const { equipment, alice } = await setupMembersAndEquipment();

    // La coercition Ajv promouvait `null` en `0` : un champ obligatoire oublié par le front
    // devenait une valeur d'achat de 0 €, ou un montant nul dans un calcul de soldes.
    const sansValeur = await post(
      '/api/equipments',
      equipmentPayload({ memberIds: [alice.id], purchaseValueEuros: null }),
      alice.cookies,
    );
    expect(sansValeur.statusCode, sansValeur.body).toBe(400);

    const sansMontant = await post(
      '/api/expenses',
      {
        equipmentId: equipment.id,
        label: 'Gasoil',
        amountEuros: null,
        payerId: alice.id,
        date: '2026-07-01',
        category: 'FUEL',
        split: { type: 'EQUAL' },
      },
      alice.cookies,
    );
    expect(sansMontant.statusCode, sansMontant.body).toBe(400);
    expect(erreur(sansMontant)).toMatch(/champ « amountEuros »/);
  });
});

describe('API — plafonds de requêtes (rate-limit)', () => {
  let tmpRoot: string;
  let bridée: FastifyInstance;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharemate-quota-'));
    bridée = await buildTestApp({
      rateLimits: { global: 3, sensitive: 1 },
      uploadsDir: path.join(tmpRoot, 'uploads'),
    });
  });

  afterEach(async () => {
    await bridée.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Session sur l'app bridée : le bootstrap est public et hors quota « sensible ». */
  async function session(): Promise<Cookies> {
    const res = await bridée.inject({
      method: 'POST',
      url: '/api/auth/bootstrap',
      payload: { name: 'Alice', password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    return sessionCookie(res);
  }

  it('plafonne par défaut toute route, y compris celles sans limite propre', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await bridée.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    }
    const coupée = await bridée.inject({ method: 'GET', url: '/api/health' });
    expect(coupée.statusCode).toBe(429);
    expect((coupée.json() as { error: string }).error).toMatch(/^Trop de requêtes\./);
  });

  it('plafonne plus bas la création de compte et le téléversement', async () => {
    const cookies = await session();

    // Création de compte : chaque appel ouvre un compte et émet un lien d'invitation.
    const membre = (name: string) => bridée.inject({ method: 'POST', url: '/api/members', payload: { name }, cookies });
    expect((await membre('Bruno')).statusCode).toBe(201);
    expect((await membre('Chloé')).statusCode).toBe(429);

    // Téléversement : 10 Mo par fichier, jamais supprimé — le plafond global serait trop haut.
    const envoi = () => {
      const { payload, headers } = filePayload('recu.png', Buffer.from('image-factice'));
      return bridée.inject({ method: 'POST', url: '/api/uploads/receipts', payload, headers, cookies });
    };
    expect((await envoi()).statusCode).toBe(201);
    expect((await envoi()).statusCode).toBe(429);
  });
});
