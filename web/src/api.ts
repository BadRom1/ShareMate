/** Client HTTP de l'API ShareMate (adapter de présentation). */

import { getToken, isNative, setToken } from './native';

/**
 * Base de l'API. Vide en web (même-origine, chemins relatifs `/api/...`) ; l'URL du backend
 * distant en natif, injectée au build via `VITE_API_BASE_URL`.
 */
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

/** Résout un chemin servi par le backend (ex. `/uploads/x.jpg`) en URL affichable (absolue en natif). */
export function assetUrl(path: string): string {
  return `${API_BASE}${path}`;
}

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

export interface Thread {
  id: string;
  equipmentId: string;
  authorId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** Fil enrichi du nombre de messages, pour la liste des fils. */
export interface ThreadSummary extends Thread {
  messageCount: number;
}

export interface Message {
  id: string;
  threadId: string;
  authorId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

export type NotificationType =
  'MESSAGE_POSTED' | 'EXPENSE_ADDED' | 'RESERVATION_CREATED' | 'REIMBURSEMENT_RECORDED' | 'MAINTENANCE_ALERT';

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationPreference {
  type: NotificationType;
  inApp: boolean;
  push: boolean;
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

/** En-têtes communs : JSON si corps, et sur natif l'auth par Bearer + l'annonce du client. */
function buildHeaders(hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (hasBody) headers['Content-Type'] = 'application/json';
  if (isNative) {
    headers['X-ShareMate-Client'] = 'native';
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: { ...buildHeaders(Boolean(options?.body)), ...options?.headers },
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

/** Requête d'auth : sur natif, capture le token renvoyé pour authentifier les appels suivants. */
async function authRequest(url: string, options: RequestInit): Promise<{ member: Member }> {
  const res = await request<{ member: Member; token?: string }>(url, options);
  if (isNative && res.token) await setToken(res.token);
  return { member: res.member };
}

export const api = {
  me: () => request<AuthState>('/api/auth/me'),
  bootstrap: (input: { name: string; email?: string; password: string }) =>
    authRequest('/api/auth/bootstrap', { method: 'POST', body: JSON.stringify(input) }),
  login: (identifier: string, password: string) =>
    authRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier, password }) }),
  logout: async () => {
    await request<void>('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    await setToken(null);
  },
  inviteInfo: (code: string) => request<{ memberName: string }>(`/api/auth/invites/${encodeURIComponent(code)}`),
  redeemInvite: (code: string, password: string) =>
    authRequest(`/api/auth/invites/${encodeURIComponent(code)}/redeem`, {
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

  listThreads: (equipmentId: string) => request<ThreadSummary[]>(`/api/equipments/${equipmentId}/threads`),
  createThread: (equipmentId: string, title: string, body?: string) =>
    request<Thread>('/api/threads', { method: 'POST', body: JSON.stringify({ equipmentId, title, body }) }),
  renameThread: (id: string, title: string) =>
    request<Thread>(`/api/threads/${id}`, { method: 'PUT', body: JSON.stringify({ title }) }),
  deleteThread: (id: string) => request<void>(`/api/threads/${id}`, { method: 'DELETE' }),

  listMessages: (threadId: string) => request<Message[]>(`/api/threads/${threadId}/messages`),
  postMessage: (threadId: string, body: string) =>
    request<Message>('/api/messages', { method: 'POST', body: JSON.stringify({ threadId, body }) }),
  editMessage: (id: string, body: string) =>
    request<Message>(`/api/messages/${id}`, { method: 'PUT', body: JSON.stringify({ body }) }),
  deleteMessage: (id: string) => request<void>(`/api/messages/${id}`, { method: 'DELETE' }),

  listNotifications: (unreadOnly = false) =>
    request<AppNotification[]>(`/api/notifications${unreadOnly ? '?unread=1' : ''}`),
  unreadCount: () => request<{ count: number }>('/api/notifications/unread-count'),
  markNotificationRead: (id: string) =>
    request<void>(`/api/notifications/${id}/read`, { method: 'POST', body: JSON.stringify({}) }),
  markAllNotificationsRead: () =>
    request<void>('/api/notifications/read-all', { method: 'POST', body: JSON.stringify({}) }),
  notificationPreferences: () => request<NotificationPreference[]>('/api/notifications/preferences'),
  updateNotificationPreferences: (preferences: NotificationPreference[]) =>
    request<NotificationPreference[]>('/api/notifications/preferences', {
      method: 'PUT',
      body: JSON.stringify({ preferences }),
    }),
  vapidPublicKey: () => request<{ publicKey: string | null }>('/api/notifications/vapid-public-key'),
  subscribeWebPush: (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    request<{ status: string }>('/api/notifications/subscriptions', {
      method: 'POST',
      body: JSON.stringify(subscription),
    }),
  unsubscribeWebPush: (endpoint: string) =>
    request<void>('/api/notifications/subscriptions', { method: 'DELETE', body: JSON.stringify({ endpoint }) }),
  registerDeviceToken: (token: string, platform: string) =>
    request<{ status: string }>('/api/notifications/device-tokens', {
      method: 'POST',
      body: JSON.stringify({ token, platform }),
    }),

  uploadReceipt: async (file: File): Promise<string> => {
    const form = new FormData();
    form.append('file', file);
    // Pas de Content-Type manuel : le navigateur pose la frontière multipart. On garde l'auth native.
    const response = await fetch(`${API_BASE}/api/uploads/receipts`, {
      method: 'POST',
      body: form,
      headers: buildHeaders(false),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(body.error ?? "Échec de l'upload.", response.status);
    }
    return ((await response.json()) as { path: string }).path;
  },
};
