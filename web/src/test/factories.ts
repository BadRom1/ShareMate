/** Fabriques et doublures partagées par les tests du front. */
import { vi } from 'vitest';
import type {
  AppNotification,
  AuthState,
  Balance,
  ChecklistItem,
  ChecklistSummary,
  DirectoryMember,
  EquipmentDocument,
  Equipment,
  Expense,
  MaintenanceStatus,
  Member,
  Message,
  Reimbursement,
  Reservation,
  SettlementTransaction,
  ThreadSummary,
  UsageRecord,
} from '../api';

export function aMember(over: Partial<DirectoryMember> = {}): DirectoryMember {
  return { id: 'm1', name: 'Alice', email: null, hasPassword: true, ...over };
}

export function anEquipment(over: Partial<Equipment> = {}): Equipment {
  return {
    id: 'e1',
    name: 'Tracteur',
    category: 'Agricole',
    acquisitionDate: '2020-01-01',
    purchaseValueEuros: 10000,
    meterUnit: 'HOURS',
    memberIds: ['m1'],
    maintenanceThreshold: null,
    ...over,
  };
}

export function aReservation(over: Partial<Reservation> = {}): Reservation {
  return {
    id: 'r1',
    equipmentId: 'e1',
    memberId: 'm1',
    start: '2026-03-02T08:00:00.000Z',
    end: '2026-03-02T10:00:00.000Z',
    status: 'REQUIRED',
    createdAt: '2026-03-01T08:00:00.000Z',
    conflictIds: [],
    notes: null,
    ...over,
  };
}

export function aThread(over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: 't1',
    equipmentId: 'e1',
    authorId: 'm1',
    title: 'Panne moteur',
    createdAt: '2026-03-01T08:00:00.000Z',
    updatedAt: '2026-03-01T08:00:00.000Z',
    messageCount: 1,
    ...over,
  };
}

export function aMessage(over: Partial<Message> = {}): Message {
  return {
    id: 'msg1',
    threadId: 't1',
    authorId: 'm1',
    body: 'Le démarreur fait un bruit bizarre.',
    createdAt: '2026-03-01T08:00:00.000Z',
    editedAt: null,
    parentId: null,
    ...over,
  };
}

export function anExpense(over: Partial<Expense> = {}): Expense {
  return {
    id: 'x1',
    equipmentId: 'e1',
    label: 'Plein de gazole',
    amountEuros: 90,
    payerId: 'm1',
    date: '2026-03-02',
    category: 'FUEL',
    receiptPath: null,
    sharesEuros: { m1: 45, m2: 45 },
    ...over,
  };
}

export function aReimbursement(over: Partial<Reimbursement> = {}): Reimbursement {
  return {
    id: 'rb1',
    equipmentId: 'e1',
    fromMemberId: 'm2',
    toMemberId: 'm1',
    amountEuros: 45,
    date: '2026-03-03',
    notes: null,
    ...over,
  };
}

export function aDocument(over: Partial<EquipmentDocument> = {}): EquipmentDocument {
  return {
    id: 'd1',
    equipmentId: 'e1',
    authorId: 'm1',
    name: 'Manuel d’utilisation',
    category: 'MANUAL',
    createdAt: '2026-03-01T08:00:00.000Z',
    kind: 'FILE',
    fileName: 'manuel.pdf',
    contentType: 'application/pdf',
    sizeBytes: 4_200_000,
    url: null,
    ...over,
  };
}

/** Lien externe : la nature bascule, et les champs de fichier retombent à `null`. */
export function aDocumentLink(over: Partial<EquipmentDocument> = {}): EquipmentDocument {
  return aDocument({
    id: 'd2',
    name: 'Catalogue de pièces',
    category: 'OTHER',
    kind: 'LINK',
    fileName: null,
    contentType: null,
    sizeBytes: null,
    url: 'https://kubota-eu.com/pieces',
    ...over,
  });
}

export function aMaintenanceStatus(over: Partial<MaintenanceStatus> = {}): MaintenanceStatus {
  return {
    equipmentId: 'e1',
    threshold: null,
    currentReading: null,
    lastMaintenanceReading: null,
    unitsSinceMaintenance: null,
    alert: false,
    ...over,
  };
}

export type ApiStub = ReturnType<typeof createApiStub>;

/**
 * Doublure du client d'API. Toutes les méthodes appelées au montage d'une page doivent exister :
 * un onglet en charge plusieurs ressources d'un coup, une méthode manquante casserait le rendu
 * ailleurs que sur le comportement testé.
 */
export function createApiStub() {
  const me: Member = aMember();
  return {
    me: vi.fn(async (): Promise<AuthState> => ({ member: me, needsBootstrap: false })),
    login: vi.fn(async (_identifier: string, _password: string) => ({ member: me })),
    bootstrap: vi.fn(async (_input: { name: string; email?: string; password: string }) => ({ member: me })),
    logout: vi.fn(async () => {}),
    inviteInfo: vi.fn(async (_code: string) => ({ memberName: 'Bob' })),
    redeemInvite: vi.fn(async (_code: string, _password: string) => ({ member: me })),

    listMembers: vi.fn(async () => [aMember()]),
    createMember: vi.fn(async (_input: { name: string; email?: string }) => ({
      ...aMember({ id: 'm9', name: 'Nouveau', hasPassword: false }),
      inviteCode: 'code-9',
    })),
    regenerateInvite: vi.fn(async (_memberId: string) => ({ inviteCode: 'code-9' })),

    listEquipments: vi.fn(async () => [anEquipment()]),
    createEquipment: vi.fn(async (_input: unknown) => anEquipment()),
    updateEquipment: vi.fn(async (_id: string, _input: unknown) => anEquipment()),
    deleteEquipment: vi.fn(async (_id: string) => {}),
    leaveEquipment: vi.fn(async (_id: string) => {}),

    calendar: vi.fn(async () => [] as Reservation[]),
    reserve: vi.fn(async () => aReservation()),
    reserveRecurring: vi.fn(async () => [aReservation()]),
    updateReservation: vi.fn(async () => aReservation()),
    cancelReservation: vi.fn(async (_id: string) => {}),

    alerts: vi.fn(async () => [] as MaintenanceStatus[]),
    maintenanceStatus: vi.fn(async (_equipmentId: string) => aMaintenanceStatus()),
    usageByEquipment: vi.fn(async (_equipmentId: string) => [] as UsageRecord[]),
    usageByMember: vi.fn(async (_memberId: string) => [] as UsageRecord[]),

    listExpenses: vi.fn(async (_equipmentId: string) => [] as Expense[]),
    addExpense: vi.fn(async (_input: unknown) => anExpense()),
    deleteExpense: vi.fn(async (_id: string) => {}),
    balances: vi.fn(async (_equipmentId: string) => [] as Balance[]),
    settlement: vi.fn(async (_equipmentId: string) => [] as SettlementTransaction[]),
    listReimbursements: vi.fn(async (_equipmentId: string) => [] as Reimbursement[]),
    recordReimbursement: vi.fn(async (_input: unknown) => aReimbursement()),
    uploadReceipt: vi.fn(async (_file: File) => '/uploads/0189a4c2-1f3b-4d5e-8a9b-0c1d2e3f4a5b.jpg'),

    listThreads: vi.fn(async (_equipmentId: string) => [] as ThreadSummary[]),
    listMessages: vi.fn(async (_threadId: string) => [] as Message[]),
    createThread: vi.fn(async (_equipmentId: string, _title: string, _body?: string) => aThread()),
    renameThread: vi.fn(async (_id: string, _title: string) => aThread()),
    deleteThread: vi.fn(async (_id: string) => {}),
    postMessage: vi.fn(async (_threadId: string, _body: string, _parentId?: string | null) => aMessage()),
    editMessage: vi.fn(async (_id: string, _body: string) => aMessage()),
    deleteMessage: vi.fn(async (_id: string) => {}),

    listChecklists: vi.fn(async (_equipmentId: string) => [] as ChecklistSummary[]),
    listChecklistItems: vi.fn(async (_checklistId: string) => [] as ChecklistItem[]),

    listDocuments: vi.fn(async (_equipmentId: string) => [] as EquipmentDocument[]),
    addDocumentLink: vi.fn(async (_input: unknown) => aDocumentLink()),
    uploadDocument: vi.fn(async (_file: File, _meta: unknown) => aDocument()),
    updateDocument: vi.fn(async (_id: string, _changes: unknown) => aDocument()),
    deleteDocument: vi.fn(async (_id: string) => {}),

    unreadCount: vi.fn(async () => ({ count: 0 })),
    listNotifications: vi.fn(async () => [] as AppNotification[]),
  };
}
