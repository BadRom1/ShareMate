/** Client HTTP de l'API ShareMate (adapter de présentation). */

export interface Member {
  id: string;
  name: string;
  email: string | null;
}

export type MeterUnit = 'HOURS' | 'KILOMETERS';

/** Un équipement porte son cercle d'utilisateurs (`memberIds`). */
export interface Equipment {
  id: string;
  name: string;
  category: string;
  acquisitionDate: string;
  purchaseValueEuros: number;
  meterUnit: MeterUnit;
  memberIds: string[];
  maintenanceThreshold: number | null;
}

/** PLANNED = prévisionnel, REQUIRED = nécessaire/obligatoire. */
export type ReservationStatus = 'PLANNED' | 'REQUIRED';

export type RecurrenceFrequency = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';

export interface Reservation {
  id: string;
  equipmentId: string;
  memberId: string;
  start: string;
  end: string;
  status: ReservationStatus;
  createdAt: string;
  conflictIds: string[];
  notes: string | null;
}

export interface UsageRecord {
  id: string;
  equipmentId: string;
  memberId: string;
  recordedAt: string;
  meterReading: number;
  /** Durée (heures/km) attribuée au membre : delta avec le relevé précédent, null pour le premier relevé. */
  duration: number | null;
  fuelAddedLiters: number | null;
  notes: string | null;
  isMaintenance: boolean;
}

export interface MaintenanceStatus {
  equipmentId: string;
  threshold: number | null;
  currentReading: number | null;
  lastMaintenanceReading: number | null;
  unitsSinceMaintenance: number | null;
  alert: boolean;
}

export type ExpenseCategory = 'PURCHASE' | 'INSURANCE' | 'FUEL' | 'MAINTENANCE' | 'REPAIR' | 'OTHER';

export type SplitInput =
  | { type: 'EQUAL'; memberIds?: string[] }
  | { type: 'USAGE_PRORATED' }
  | { type: 'CUSTOM'; amountsEuros: Record<string, number> };

export interface Expense {
  id: string;
  equipmentId: string;
  label: string;
  amountEuros: number;
  payerId: string;
  date: string;
  category: ExpenseCategory;
  receiptPath: string | null;
  sharesEuros: Record<string, number>;
}

export interface Reimbursement {
  id: string;
  equipmentId: string;
  fromMemberId: string;
  toMemberId: string;
  amountEuros: number;
  date: string;
  notes: string | null;
}

export interface Balance {
  memberId: string;
  balanceEuros: number;
}

export interface SettlementTransaction {
  fromMemberId: string;
  toMemberId: string;
  amountEuros: number;
}

export interface AuthState {
  member: Member | null;
  needsBootstrap: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;

/** Rappelé sur tout 401 hors routes d'auth : la session a expiré, retour à l'écran de connexion. */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  if (response.status === 401 && !url.startsWith('/api/auth/')) {
    onUnauthorized?.();
  }
  if (!response.ok) {
    let message = `Erreur ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* corps non JSON */
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  me: () => request<AuthState>('/api/auth/me'),
  bootstrap: (input: { name: string; email?: string; password: string }) =>
    request<{ member: Member }>('/api/auth/bootstrap', { method: 'POST', body: JSON.stringify(input) }),
  login: (identifier: string, password: string) =>
    request<{ member: Member }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier, password }) }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) }),
  inviteInfo: (code: string) => request<{ memberName: string }>(`/api/auth/invites/${encodeURIComponent(code)}`),
  redeemInvite: (code: string, password: string) =>
    request<{ member: Member }>(`/api/auth/invites/${encodeURIComponent(code)}/redeem`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),

  listMembers: () => request<Member[]>('/api/members'),
  createMember: (input: { name: string; email?: string }) =>
    request<Member & { inviteCode: string }>('/api/members', { method: 'POST', body: JSON.stringify(input) }),
  regenerateInvite: (memberId: string) =>
    request<{ inviteCode: string }>(`/api/members/${memberId}/invite`, { method: 'POST', body: JSON.stringify({}) }),

  listEquipments: () => request<Equipment[]>('/api/equipments'),
  createEquipment: (input: Omit<Equipment, 'id'>) =>
    request<Equipment>('/api/equipments', { method: 'POST', body: JSON.stringify(input) }),
  updateEquipment: (id: string, input: Partial<Omit<Equipment, 'id'>>) =>
    request<Equipment>(`/api/equipments/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteEquipment: (id: string) => request<void>(`/api/equipments/${id}`, { method: 'DELETE' }),

  calendar: () => request<Reservation[]>('/api/calendar'),
  reserve: (input: { equipmentId: string; start: string; end: string; status?: ReservationStatus; notes?: string }) =>
    request<Reservation>('/api/reservations', { method: 'POST', body: JSON.stringify(input) }),
  reserveRecurring: (input: {
    equipmentId: string;
    start: string;
    end: string;
    status?: ReservationStatus;
    notes?: string;
    frequency: RecurrenceFrequency;
    until: string;
  }) => request<Reservation[]>('/api/reservations/recurring', { method: 'POST', body: JSON.stringify(input) }),
  updateReservation: (
    id: string,
    changes: { start?: string; end?: string; status?: ReservationStatus; notes?: string | null },
  ) => request<Reservation>(`/api/reservations/${id}`, { method: 'PUT', body: JSON.stringify(changes) }),
  cancelReservation: (id: string) => request<void>(`/api/reservations/${id}`, { method: 'DELETE' }),

  recordUsage: (input: {
    equipmentId: string;
    /** Relevé de compteur, ou `duration` pour laisser le serveur le calculer depuis le dernier relevé. */
    meterReading?: number;
    duration?: number;
    fuelAddedLiters?: number | null;
    notes?: string | null;
    isMaintenance?: boolean;
  }) => request<UsageRecord>('/api/usage', { method: 'POST', body: JSON.stringify(input) }),
  usageByEquipment: (equipmentId: string) => request<UsageRecord[]>(`/api/equipments/${equipmentId}/usage`),
  usageByMember: (memberId: string) => request<UsageRecord[]>(`/api/members/${memberId}/usage`),
  maintenanceStatus: (equipmentId: string) => request<MaintenanceStatus>(`/api/equipments/${equipmentId}/maintenance`),
  alerts: () => request<MaintenanceStatus[]>('/api/alerts'),

  listExpenses: (equipmentId: string) => request<Expense[]>(`/api/equipments/${equipmentId}/expenses`),
  addExpense: (input: {
    equipmentId: string;
    label: string;
    amountEuros: number;
    payerId: string;
    date: string;
    category: ExpenseCategory;
    split: SplitInput;
    receiptPath?: string | null;
  }) => request<Expense>('/api/expenses', { method: 'POST', body: JSON.stringify(input) }),
  deleteExpense: (id: string) => request<void>(`/api/expenses/${id}`, { method: 'DELETE' }),
  balances: (equipmentId: string) => request<Balance[]>(`/api/equipments/${equipmentId}/balances`),
  settlement: (equipmentId: string) => request<SettlementTransaction[]>(`/api/equipments/${equipmentId}/settlement`),
  listReimbursements: (equipmentId: string) =>
    request<Reimbursement[]>(`/api/equipments/${equipmentId}/reimbursements`),
  recordReimbursement: (input: {
    equipmentId: string;
    fromMemberId: string;
    toMemberId: string;
    amountEuros: number;
    date: string;
    notes?: string;
  }) => request<Reimbursement>('/api/reimbursements', { method: 'POST', body: JSON.stringify(input) }),

  uploadReceipt: async (file: File): Promise<string> => {
    const form = new FormData();
    form.append('file', file);
    const response = await fetch('/api/uploads/receipts', { method: 'POST', body: form });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(body.error ?? "Échec de l'upload.", response.status);
    }
    return ((await response.json()) as { path: string }).path;
  },
};
