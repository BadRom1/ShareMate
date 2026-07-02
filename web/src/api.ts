/** Client HTTP de l'API ShareMate (adapter de présentation). */

export interface Member {
  id: string;
  name: string;
  email: string | null;
}

export interface Group {
  id: string;
  name: string;
  memberIds: string[];
}

export interface GroupDetail extends Group {
  members: Member[];
}

export type MeterUnit = 'HOURS' | 'KILOMETERS';

export interface Equipment {
  id: string;
  groupId: string;
  name: string;
  category: string;
  acquisitionDate: string;
  purchaseValueEuros: number;
  meterUnit: MeterUnit;
  accessMemberIds: string[];
  maintenanceThreshold: number | null;
}

export interface Reservation {
  id: string;
  equipmentId: string;
  memberId: string;
  start: string;
  end: string;
  notes: string | null;
}

export interface UsageRecord {
  id: string;
  equipmentId: string;
  memberId: string;
  recordedAt: string;
  meterReading: number;
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
  groupId: string;
  equipmentId: string | null;
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
  groupId: string;
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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
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
  listGroups: () => request<Group[]>('/api/groups'),
  getGroup: (id: string) => request<GroupDetail>(`/api/groups/${id}`),
  createGroup: (input: { name: string; members: { name: string; email?: string }[] }) =>
    request<Group>('/api/groups', { method: 'POST', body: JSON.stringify(input) }),
  addMember: (groupId: string, input: { name: string; email?: string }) =>
    request<Member>(`/api/groups/${groupId}/members`, { method: 'POST', body: JSON.stringify(input) }),

  listEquipments: (groupId: string) => request<Equipment[]>(`/api/groups/${groupId}/equipments`),
  createEquipment: (input: Omit<Equipment, 'id'>) =>
    request<Equipment>('/api/equipments', { method: 'POST', body: JSON.stringify(input) }),
  updateEquipment: (id: string, input: Partial<Omit<Equipment, 'id' | 'groupId'>>) =>
    request<Equipment>(`/api/equipments/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteEquipment: (id: string) => request<void>(`/api/equipments/${id}`, { method: 'DELETE' }),

  groupCalendar: (groupId: string) => request<Reservation[]>(`/api/groups/${groupId}/calendar`),
  reserve: (input: { equipmentId: string; memberId: string; start: string; end: string; notes?: string }) =>
    request<Reservation>('/api/reservations', { method: 'POST', body: JSON.stringify(input) }),
  cancelReservation: (id: string) => request<void>(`/api/reservations/${id}`, { method: 'DELETE' }),

  recordUsage: (input: {
    equipmentId: string;
    memberId: string;
    meterReading: number;
    fuelAddedLiters?: number | null;
    notes?: string | null;
    isMaintenance?: boolean;
  }) => request<UsageRecord>('/api/usage', { method: 'POST', body: JSON.stringify(input) }),
  usageByEquipment: (equipmentId: string) => request<UsageRecord[]>(`/api/equipments/${equipmentId}/usage`),
  usageByMember: (memberId: string) => request<UsageRecord[]>(`/api/members/${memberId}/usage`),
  maintenanceStatus: (equipmentId: string) =>
    request<MaintenanceStatus>(`/api/equipments/${equipmentId}/maintenance`),
  groupAlerts: (groupId: string) => request<MaintenanceStatus[]>(`/api/groups/${groupId}/alerts`),

  listExpenses: (groupId: string) => request<Expense[]>(`/api/groups/${groupId}/expenses`),
  addExpense: (input: {
    groupId: string;
    equipmentId?: string | null;
    label: string;
    amountEuros: number;
    payerId: string;
    date: string;
    category: ExpenseCategory;
    split: SplitInput;
    receiptPath?: string | null;
  }) => request<Expense>('/api/expenses', { method: 'POST', body: JSON.stringify(input) }),
  deleteExpense: (id: string) => request<void>(`/api/expenses/${id}`, { method: 'DELETE' }),
  balances: (groupId: string) => request<Balance[]>(`/api/groups/${groupId}/balances`),
  settlement: (groupId: string) => request<SettlementTransaction[]>(`/api/groups/${groupId}/settlement`),
  listReimbursements: (groupId: string) => request<Reimbursement[]>(`/api/groups/${groupId}/reimbursements`),
  recordReimbursement: (input: {
    groupId: string;
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
      throw new ApiError(body.error ?? 'Échec de l\'upload.', response.status);
    }
    return ((await response.json()) as { path: string }).path;
  },
};
