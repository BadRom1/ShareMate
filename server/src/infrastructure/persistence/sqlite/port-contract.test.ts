import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import {
  SqliteDocumentRepository,
  SqliteEquipmentRepository,
  SqliteMessageRepository,
  SqliteThreadRepository,
  SqliteExpenseRepository,
  SqliteMemberRepository,
  SqliteNotificationRepository,
  SqliteReimbursementRepository,
  SqliteReservationRepository,
  SqliteSubEquipmentRepository,
  SqliteUsageRecordRepository,
} from './repositories.js';
import {
  InMemoryDocumentRepository,
  InMemoryEquipmentRepository,
  InMemoryMessageRepository,
  InMemoryThreadRepository,
  InMemoryExpenseRepository,
  InMemoryMemberRepository,
  InMemoryNotificationRepository,
  InMemoryReimbursementRepository,
  InMemoryReservationRepository,
  InMemorySubEquipmentRepository,
  InMemoryUsageRecordRepository,
} from '../../../application/testing/in-memory.js';
import { NOTIFICATION_PAGE_SIZE } from '../../../application/ports.js';
import type {
  DocumentRepository,
  EquipmentRepository,
  MessageRepository,
  ThreadRepository,
  ExpenseRepository,
  MemberRepository,
  NotificationRepository,
  ReimbursementRepository,
  ReservationRepository,
  SubEquipmentRepository,
  UsageRecordRepository,
} from '../../../application/ports.js';
import { Member } from '../../../domain/member/member.js';
import { Equipment } from '../../../domain/equipment/equipment.js';
import { SubEquipment } from '../../../domain/equipment/sub-equipment.js';
import { Reservation } from '../../../domain/reservation/reservation.js';
import { UsageRecord } from '../../../domain/usage/usage-record.js';
import { Expense } from '../../../domain/expense/expense.js';
import { Document } from '../../../domain/document/document.js';
import { Message } from '../../../domain/discussion/message.js';
import { Thread } from '../../../domain/discussion/thread.js';
import { Reimbursement } from '../../../domain/expense/reimbursement.js';
import { Notification } from '../../../domain/notification/notification.js';
import { Money } from '../../../domain/shared/money.js';
import { TimeRange } from '../../../domain/shared/time-range.js';

/**
 * Contrat des ports de persistance, joué à l'identique sur l'adapter SQLite et sur son double en
 * mémoire. La suite unitaire de la couche application tourne entièrement sur les doubles : si l'un
 * d'eux s'écarte de l'adapter réel, elle atteste d'un comportement que la production n'a pas. Ce
 * fichier est le seul endroit où les deux implémentations sont confrontées.
 *
 * Il ne couvre que ce que le port promet — l'ordre des listes et les bornes par défaut — et non
 * les détails de chaque implémentation, éprouvés par `repositories.test.ts` de leur côté.
 */

interface Dépôts {
  members: MemberRepository;
  equipments: EquipmentRepository;
  subEquipments: SubEquipmentRepository;
  reservations: ReservationRepository;
  usageRecords: UsageRecordRepository;
  expenses: ExpenseRepository;
  reimbursements: ReimbursementRepository;
  documents: DocumentRepository;
  threads: ThreadRepository;
  messages: MessageRepository;
  notifications: NotificationRepository;
}

const IMPLÉMENTATIONS: { nom: string; ouvrir: () => Dépôts }[] = [
  {
    nom: 'SQLite',
    ouvrir: () => {
      const db = openDatabase(':memory:');
      return {
        members: new SqliteMemberRepository(db),
        equipments: new SqliteEquipmentRepository(db),
        subEquipments: new SqliteSubEquipmentRepository(db),
        reservations: new SqliteReservationRepository(db),
        usageRecords: new SqliteUsageRecordRepository(db),
        expenses: new SqliteExpenseRepository(db),
        reimbursements: new SqliteReimbursementRepository(db),
        documents: new SqliteDocumentRepository(db),
        threads: new SqliteThreadRepository(db),
        messages: new SqliteMessageRepository(db),
        notifications: new SqliteNotificationRepository(db),
      };
    },
  },
  {
    nom: 'en mémoire',
    ouvrir: () => ({
      members: new InMemoryMemberRepository(),
      equipments: new InMemoryEquipmentRepository(),
      subEquipments: new InMemorySubEquipmentRepository(),
      reservations: new InMemoryReservationRepository(),
      usageRecords: new InMemoryUsageRecordRepository(),
      expenses: new InMemoryExpenseRepository(),
      reimbursements: new InMemoryReimbursementRepository(),
      documents: new InMemoryDocumentRepository(),
      ...(() => {
        // Le double doit répondre « les messages de cet équipement » comme le fait la jointure
        // SQL : il lui faut donc connaître les fils.
        const threads = new InMemoryThreadRepository();
        return { threads, messages: new InMemoryMessageRepository(threads) };
      })(),
      notifications: new InMemoryNotificationRepository(),
    }),
  },
];

function équipement(id: string, name: string, memberIds: string[]): Equipment {
  return Equipment.create({
    id,
    name,
    category: 'BTP',
    acquisitionDate: new Date('2025-01-01T00:00:00.000Z'),
    purchaseValue: Money.fromEuros(15000),
    meterUnit: 'HOURS',
    memberIds,
    maintenanceThreshold: null,
  });
}

function sousÉquipement(id: string, equipmentId: string, position: number): SubEquipment {
  return SubEquipment.create({ id, equipmentId, name: `Élément ${id}`, quantity: 1, position });
}

function réservation(id: string, equipmentId: string, début: string): Reservation {
  return Reservation.create({
    id,
    equipmentId,
    memberId: 'm1',
    range: TimeRange.create(new Date(début), new Date(new Date(début).getTime() + 3_600_000)),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  });
}

function relevé(id: string, equipmentId: string, memberId: string, quand: string, compteur: number): UsageRecord {
  return UsageRecord.create({
    id,
    equipmentId,
    memberId,
    recordedAt: new Date(quand),
    meterReading: compteur,
  });
}

function dépense(id: string, equipmentId: string, date: string): Expense {
  return Expense.create({
    id,
    equipmentId,
    label: `Dépense ${id}`,
    amount: Money.fromEuros(100),
    payerId: 'm1',
    date: new Date(date),
    category: 'FUEL',
    split: { type: 'EQUAL', memberIds: ['m1'] },
  });
}

function remboursement(id: string, equipmentId: string, date: string): Reimbursement {
  return Reimbursement.create({
    id,
    equipmentId,
    fromMemberId: 'm2',
    toMemberId: 'm1',
    amount: Money.fromEuros(10),
    date: new Date(date),
  });
}

function document(id: string, equipmentId: string, quand: string, storageKey?: string): Document {
  return Document.create({
    id,
    equipmentId,
    authorId: 'm1',
    name: `Document ${id}`,
    category: 'MANUAL',
    content: storageKey
      ? { type: 'FILE', storageKey, fileName: 'manuel.pdf', contentType: 'application/pdf', sizeBytes: 1000 }
      : { type: 'LINK', url: `https://exemple.fr/${id}` },
    createdAt: new Date(quand),
  });
}

function notification(id: string, quand: string): Notification {
  return Notification.create({
    id,
    recipientId: 'm1',
    type: 'MESSAGE_POSTED',
    title: `Notification ${id}`,
    body: '',
    createdAt: new Date(quand),
  });
}

describe.each(IMPLÉMENTATIONS)('Contrat des ports — $nom', ({ ouvrir }) => {
  let dépôts: Dépôts;

  beforeEach(async () => {
    dépôts = ouvrir();
    // Les clés étrangères de SQLite imposent membres puis équipements : le double n'en a cure,
    // mais la fixture doit rester la même des deux côtés pour que la comparaison ait un sens.
    // L'ordre d'insertion contredit délibérément l'ordre attendu : sans tri, les deux coïncident
    // et le contrat passerait au vert sans être tenu.
    await dépôts.members.save(Member.create({ id: 'm2', name: 'Zoé', email: 'zoe@example.fr' }));
    await dépôts.members.save(Member.create({ id: 'm3', name: 'Émile' }));
    await dépôts.members.save(Member.create({ id: 'm1', name: 'Alice' }));
    await dépôts.equipments.save(équipement('e2', 'Minipelle', ['m1', 'm2']));
    await dépôts.equipments.save(équipement('e1', 'Étau', ['m1']));
    await dépôts.equipments.save(équipement('e3', 'Broyeur', ['m2']));
  });

  // « Émile » après « Zoé » : les deux implémentations comparent les points de code. Trier par
  // locale (`localeCompare`) rangerait « Émile » avec les E — divergence invisible tant qu'aucun
  // nom n'est accentué, c'est-à-dire jusqu'au premier vrai membre.
  it("range l'annuaire par nom, dans l'ordre des points de code", async () => {
    expect((await dépôts.members.findByIds(['m3', 'm2', 'm1'])).map((m) => m.name)).toEqual(['Alice', 'Zoé', 'Émile']);
  });

  it('range par nom les membres créés par un invitant', async () => {
    await dépôts.members.save(Member.create({ id: 'm4', name: 'Zoé', invitedById: 'm1' }));
    await dépôts.members.save(Member.create({ id: 'm5', name: 'Émile', invitedById: 'm1' }));
    await dépôts.members.save(Member.create({ id: 'm6', name: 'Alice', invitedById: 'm1' }));
    expect((await dépôts.members.findInvitedBy('m1')).map((m) => m.id)).toEqual(['m6', 'm4', 'm5']);
  });

  // Un nom n'est pas unique : le port rend tous les homonymes, à charge du service de trancher.
  it('rend tous les membres qui répondent à un identifiant', async () => {
    await dépôts.members.save(Member.create({ id: 'm4', name: 'Alice', email: 'alice2@example.fr' }));
    expect((await dépôts.members.findByNameOrEmail('  ALICE ')).map((m) => m.id).sort()).toEqual(['m1', 'm4']);
    expect(await dépôts.members.findByNameOrEmail('')).toEqual([]);
  });

  it('range par nom les équipements du cercle du membre', async () => {
    expect((await dépôts.equipments.findByMemberId('m1')).map((e) => e.name)).toEqual(['Minipelle', 'Étau']);
    expect((await dépôts.equipments.findByMemberId('m2')).map((e) => e.name)).toEqual(['Broyeur', 'Minipelle']);
  });

  it('range le lot par position croissante, l’identifiant départageant les ex æquo', async () => {
    await dépôts.subEquipments.save(sousÉquipement('s2', 'e2', 1));
    await dépôts.subEquipments.save(sousÉquipement('s1', 'e2', 0));
    // Deux éléments à la même position : aucun ajout n'en produit, mais une base reprise à la main
    // peut en contenir, et les deux implémentations doivent alors les rendre dans le même ordre.
    await dépôts.subEquipments.save(sousÉquipement('s4', 'e2', 2));
    await dépôts.subEquipments.save(sousÉquipement('s3', 'e2', 2));
    await dépôts.subEquipments.save(sousÉquipement('s5', 'e1', 0));

    expect((await dépôts.subEquipments.findByEquipmentId('e2')).map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4']);
    expect(await dépôts.subEquipments.findByEquipmentId('e3')).toEqual([]);
  });

  it('range les réservations par début croissant, sur un équipement comme sur plusieurs', async () => {
    await dépôts.reservations.save(réservation('r1', 'e2', '2026-03-10T08:00:00.000Z'));
    await dépôts.reservations.save(réservation('r2', 'e2', '2026-01-05T08:00:00.000Z'));
    await dépôts.reservations.save(réservation('r3', 'e1', '2026-02-01T08:00:00.000Z'));

    expect((await dépôts.reservations.findByEquipmentId('e2')).map((r) => r.id)).toEqual(['r2', 'r1']);
    expect((await dépôts.reservations.findByEquipmentIds(['e1', 'e2'])).map((r) => r.id)).toEqual(['r2', 'r3', 'r1']);
    expect(await dépôts.reservations.findByEquipmentIds([])).toEqual([]);
  });

  it('range les relevés du plus ancien au plus récent, par équipement comme par membre', async () => {
    await dépôts.usageRecords.save(relevé('u1', 'e2', 'm1', '2026-03-01T10:00:00.000Z', 30));
    await dépôts.usageRecords.save(relevé('u2', 'e2', 'm2', '2026-01-01T10:00:00.000Z', 10));
    await dépôts.usageRecords.save(relevé('u3', 'e1', 'm1', '2026-02-01T10:00:00.000Z', 20));

    expect((await dépôts.usageRecords.findByEquipmentId('e2')).map((u) => u.id)).toEqual(['u2', 'u1']);
    expect((await dépôts.usageRecords.findByEquipmentIds(['e1', 'e2'])).map((u) => u.id)).toEqual(['u2', 'u3', 'u1']);
    expect((await dépôts.usageRecords.findByMemberId('m1')).map((u) => u.id)).toEqual(['u3', 'u1']);
    expect(await dépôts.usageRecords.findByEquipmentIds([])).toEqual([]);
  });

  it('range dépenses et remboursements du plus récent au plus ancien', async () => {
    await dépôts.expenses.save(dépense('x1', 'e2', '2026-01-15T00:00:00.000Z'));
    await dépôts.expenses.save(dépense('x2', 'e2', '2026-04-15T00:00:00.000Z'));
    await dépôts.reimbursements.save(remboursement('b1', 'e2', '2026-02-01T00:00:00.000Z'));
    await dépôts.reimbursements.save(remboursement('b2', 'e2', '2026-05-01T00:00:00.000Z'));

    expect((await dépôts.expenses.findByEquipmentId('e2')).map((x) => x.id)).toEqual(['x2', 'x1']);
    expect((await dépôts.reimbursements.findByEquipmentId('e2')).map((r) => r.id)).toEqual(['b2', 'b1']);
  });

  it('range les documents du plus récent au plus ancien, l’identifiant départageant les ex æquo', async () => {
    await dépôts.documents.save(document('d1', 'e2', '2026-01-15T00:00:00.000Z'));
    await dépôts.documents.save(document('d3', 'e2', '2026-04-15T00:00:00.000Z'));
    await dépôts.documents.save(document('d2', 'e2', '2026-04-15T00:00:00.000Z'));
    await dépôts.documents.save(document('d4', 'e1', '2026-05-15T00:00:00.000Z'));

    expect((await dépôts.documents.findByEquipmentId('e2')).map((d) => d.id)).toEqual(['d3', 'd2', 'd1']);
    expect(await dépôts.documents.findByEquipmentId('e3')).toEqual([]);
  });

  it('rend tous les documents qui nomment une même clé de stockage, et une liste vide sinon', async () => {
    await dépôts.documents.save(document('d1', 'e2', '2026-01-15T00:00:00.000Z', 'documents/a.pdf'));
    await dépôts.documents.save(document('d2', 'e1', '2026-01-15T00:00:00.000Z', 'documents/a.pdf'));
    await dépôts.documents.save(document('d3', 'e2', '2026-01-15T00:00:00.000Z'));

    expect((await dépôts.documents.findByStorageKey('documents/a.pdf')).map((d) => d.id).sort()).toEqual(['d1', 'd2']);
    // Un lien ne nomme aucun objet : il ne doit jamais remonter par cette question.
    expect(await dépôts.documents.findByStorageKey('documents/inconnu.pdf')).toEqual([]);
  });

  it('rend les messages d’un équipement, tous fils confondus, du plus ancien au plus récent', async () => {
    for (const [id, equipmentId, quand] of [
      ['t1', 'e2', '2026-01-01T00:00:00.000Z'],
      ['t2', 'e2', '2026-01-02T00:00:00.000Z'],
      ['t3', 'e1', '2026-01-03T00:00:00.000Z'],
    ] as const) {
      await dépôts.threads.save(
        Thread.create({ id, equipmentId, authorId: 'm1', title: `Fil ${id}`, createdAt: new Date(quand) }),
      );
    }
    for (const [id, threadId, quand] of [
      ['g1', 't2', '2026-03-01T00:00:00.000Z'],
      ['g2', 't1', '2026-02-01T00:00:00.000Z'],
      ['g3', 't3', '2026-01-15T00:00:00.000Z'],
    ] as const) {
      await dépôts.messages.save(
        Message.create({ id, threadId, authorId: 'm1', body: `Message ${id}`, createdAt: new Date(quand) }),
      );
    }

    expect((await dépôts.messages.findByEquipmentId('e2')).map((m) => m.id)).toEqual(['g2', 'g1']);
    expect((await dépôts.messages.findByEquipmentId('e1')).map((m) => m.id)).toEqual(['g3']);
    expect(await dépôts.messages.findByEquipmentId('e3')).toEqual([]);
  });

  it('rend les notifications de la plus récente à la plus ancienne, plafonnées sans `limit`', async () => {
    // Un cran au-dessus du plafond : sans borne par défaut, la cloche chargerait tout l'historique.
    const total = NOTIFICATION_PAGE_SIZE + 5;
    for (let i = 0; i < total; i += 1) {
      await dépôts.notifications.save(notification(`n${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()));
    }
    const page = await dépôts.notifications.findByRecipient('m1');
    expect(page).toHaveLength(NOTIFICATION_PAGE_SIZE);
    expect(page[0]?.id).toBe(`n${total - 1}`);
    expect((await dépôts.notifications.findByRecipient('m1', { limit: 3 })).map((n) => n.id)).toEqual([
      `n${total - 1}`,
      `n${total - 2}`,
      `n${total - 3}`,
    ]);
  });

  it('ne rend que les notifications non lues quand on le demande', async () => {
    await dépôts.notifications.save(notification('n1', '2026-01-01T00:00:00.000Z'));
    await dépôts.notifications.save(notification('n2', '2026-01-02T00:00:00.000Z'));
    await dépôts.notifications.markRead('n2');

    expect((await dépôts.notifications.findByRecipient('m1', { unreadOnly: true })).map((n) => n.id)).toEqual(['n1']);
    expect(await dépôts.notifications.countUnread('m1')).toBe(1);
  });
});
