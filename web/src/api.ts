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

/** Forme exacte des chemins produits par POST /api/uploads/receipts. */
const RECEIPT_PATH = /^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|webp|pdf)$/;

/**
 * URL d'un justificatif, ou `null` si le chemin n'est pas celui d'un fichier téléversé ici.
 * Le serveur applique la même règle à l'écriture : ce filtre couvre les dépenses enregistrées
 * avant elle, pour ne jamais rendre cliquable une URL choisie par un membre du cercle.
 */
export function receiptUrl(path: string | null): string | null {
  return path && RECEIPT_PATH.test(path) ? assetUrl(path) : null;
}

/**
 * URL du contenu d'un fichier du dossier. Elle s'ouvre par un lien du navigateur et jamais par
 * `fetch` : la réponse est une redirection vers le stockage d'objets, qu'une requête XHR ne
 * pourrait pas suivre sous la politique de sécurité de contenu (`connect-src 'self'`).
 */
export function documentContentUrl(id: string): string {
  return assetUrl(`/api/documents/${encodeURIComponent(id)}/content`);
}

/** URL de la pièce jointe d'un message. Même règle que pour un document : un lien, jamais un `fetch`. */
export function attachmentUrl(messageId: string): string {
  return assetUrl(`/api/messages/${encodeURIComponent(messageId)}/attachment`);
}

export interface Member {
  id: string;
  name: string;
  email: string | null;
}

/**
 * Membre de l'annuaire (cadré sur le périmètre du demandeur). `hasPassword` distingue un compte
 * déjà ouvert d'un compte en attente de première connexion, seul destinataire possible d'un lien
 * d'invitation.
 */
export interface DirectoryMember extends Member {
  hasPassword: boolean;
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

/**
 * Élément du lot d'un équipement : la remorque de la minipelle, ses godets, sa pompe à graisse.
 * Il décrit ce qui part avec l'équipement — il ne se réserve pas et ne porte pas de dépense.
 */
export interface SubEquipment {
  id: string;
  equipmentId: string;
  name: string;
  quantity: number;
  /** Précision libre (dimensions, état, emplacement…), ou `null`. */
  notes: string | null;
  position: number;
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

/** Fichier joint à un message. Sa clé de stockage ne sort pas du serveur : le contenu se lit par `attachmentUrl`. */
export interface MessageAttachment {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface Message {
  id: string;
  threadId: string;
  authorId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  /** Message parent (réponse dans un sous-fil), ou `null` pour un message racine. */
  parentId: string | null;
  /** Fichier joint, ou `null`. Un message en porte au plus un. */
  attachment: MessageAttachment | null;
}

/** Checklist d'un équipement (ex. « Avant utilisation »), créée par un membre du cercle. */
export interface Checklist {
  id: string;
  equipmentId: string;
  authorId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** Checklist enrichie de son avancement, pour la liste. */
export interface ChecklistSummary extends Checklist {
  itemCount: number;
  checkedCount: number;
}

export interface ChecklistItem {
  id: string;
  checklistId: string;
  label: string;
  position: number;
  /** Date de la coche, ou `null` si le point reste à faire. */
  checkedAt: string | null;
  /** Membre ayant coché le point, ou `null`. */
  checkedById: string | null;
}

/** Familles du dossier d'un équipement (fixes, comme celles des dépenses). */
export type DocumentCategory = 'MANUAL' | 'INSURANCE' | 'PURCHASE' | 'MAINTENANCE' | 'PHOTO' | 'OTHER';

export const DOCUMENT_CATEGORIES: DocumentCategory[] = [
  'MANUAL',
  'INSURANCE',
  'PURCHASE',
  'MAINTENANCE',
  'PHOTO',
  'OTHER',
];

/**
 * Document du dossier d'un équipement. Deux natures dans une seule forme : un fichier déposé
 * (`kind: 'FILE'`, dont le contenu se lit par `documentContentUrl`) ou un lien externe
 * (`kind: 'LINK'`, ouvert chez son hébergeur). Les champs de l'autre nature valent `null`.
 *
 * Nommé `EquipmentDocument` et non `Document` : ce dernier est le type du DOM, qu'un import
 * masquerait dans tout fichier qui manipule la page.
 */
export interface EquipmentDocument {
  id: string;
  equipmentId: string;
  authorId: string;
  name: string;
  category: DocumentCategory;
  createdAt: string;
  kind: 'FILE' | 'LINK';
  fileName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  url: string | null;
}

export type NotificationType =
  | 'MESSAGE_POSTED'
  | 'EXPENSE_ADDED'
  | 'RESERVATION_CREATED'
  | 'REIMBURSEMENT_RECORDED'
  | 'MAINTENANCE_ALERT'
  | 'EQUIPMENT_CIRCLE_CHANGED';

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
    // Session expirée ou révoquée. C'est le seul chemin qu'emprunte un intrus — il ne cliquera
    // pas sur « se déconnecter » —, et c'est celui que produit un changement de mot de passe, qui
    // révoque toutes les sessions du membre. L'appareil doit donc s'y vider comme à la
    // déconnexion : sans cela, le geste réflexe après une compromission laisse l'attaquant lire
    // hors ligne une journée de dépenses, de soldes, de messages et d'annuaire.
    await forgetSession();
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

/**
 * Vide les caches du service worker (`sharemate-*`, voir web/vite.config.ts). Ils gardent hors
 * ligne les réponses de l'API du membre qui se déconnecte : sans cette purge, elles restent
 * lisibles sur l'appareil, y compris par le compte suivant. Le précache du shell applicatif
 * (`workbox-*`) ne contient rien de personnel et survit, sinon l'app ne démarrerait plus hors ligne.
 */
async function purgeOfflineCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k.startsWith('sharemate-')).map((k) => caches.delete(k)));
}

/** Ne laisse plus rien de la session sur l'appareil : jeton natif et réponses d'API en cache. */
async function forgetSession(): Promise<void> {
  await setToken(null);
  await purgeOfflineCaches();
}

export const api = {
  me: () => request<AuthState>('/api/auth/me'),
  bootstrap: (input: { name: string; email?: string; password: string }) =>
    authRequest('/api/auth/bootstrap', { method: 'POST', body: JSON.stringify(input) }),
  login: (identifier: string, password: string) =>
    authRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier, password }) }),
  logout: async () => {
    try {
      await request<void>('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    } finally {
      // Même si la révocation côté serveur échoue (hors ligne), l'appareil se vide : l'écran
      // retombe de toute façon sur la connexion (App.tsx), jeton et caches ne doivent pas rester.
      await forgetSession();
    }
  },
  inviteInfo: (code: string) => request<{ memberName: string }>(`/api/auth/invites/${encodeURIComponent(code)}`),
  redeemInvite: (code: string, password: string) =>
    authRequest(`/api/auth/invites/${encodeURIComponent(code)}/redeem`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  // Le changement de mot de passe révoque toutes les sessions du membre : la réponse en rouvre
  // une, dont le jeton doit remplacer l'ancien côté natif.
  changePassword: (currentPassword: string, newPassword: string) =>
    authRequest('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),

  listMembers: () => request<DirectoryMember[]>('/api/members'),
  createMember: (input: { name: string; email?: string }) =>
    request<DirectoryMember & { inviteCode: string }>('/api/members', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  regenerateInvite: (memberId: string) =>
    request<{ inviteCode: string }>(`/api/members/${memberId}/invite`, { method: 'POST', body: JSON.stringify({}) }),

  listEquipments: () => request<Equipment[]>('/api/equipments'),
  createEquipment: (input: Omit<Equipment, 'id'>) =>
    request<Equipment>('/api/equipments', { method: 'POST', body: JSON.stringify(input) }),
  updateEquipment: (id: string, input: Partial<Omit<Equipment, 'id'>>) =>
    request<Equipment>(`/api/equipments/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteEquipment: (id: string) => request<void>(`/api/equipments/${id}`, { method: 'DELETE' }),
  /** Se retirer du cercle : geste dédié, la mise à jour de l'équipement le refuse. */
  leaveEquipment: (id: string) => request<void>(`/api/equipments/${id}/leave`, { method: 'POST' }),

  listSubEquipments: (equipmentId: string) => request<SubEquipment[]>(`/api/equipments/${equipmentId}/sub-equipments`),
  addSubEquipment: (input: { equipmentId: string; name: string; quantity?: number; notes?: string | null }) =>
    request<SubEquipment>('/api/sub-equipments', { method: 'POST', body: JSON.stringify(input) }),
  updateSubEquipment: (id: string, changes: { name?: string; quantity?: number; notes?: string | null }) =>
    request<SubEquipment>(`/api/sub-equipments/${id}`, { method: 'PUT', body: JSON.stringify(changes) }),
  deleteSubEquipment: (id: string) => request<void>(`/api/sub-equipments/${id}`, { method: 'DELETE' }),

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
  postMessage: (threadId: string, body: string, parentId?: string | null) =>
    request<Message>('/api/messages', { method: 'POST', body: JSON.stringify({ threadId, body, parentId }) }),
  editMessage: (id: string, body: string) =>
    request<Message>(`/api/messages/${id}`, { method: 'PUT', body: JSON.stringify({ body }) }),
  deleteMessage: (id: string) => request<void>(`/api/messages/${id}`, { method: 'DELETE' }),
  postMessageWithFile: async (
    threadId: string,
    file: File,
    options: { body?: string; parentId?: string | null } = {},
  ): Promise<Message> => {
    const form = new FormData();
    form.append('threadId', threadId);
    // Le corps peut être vide : la pièce jointe suffit à faire un message.
    if (options.body) form.append('body', options.body);
    if (options.parentId) form.append('parentId', options.parentId);
    form.append('file', file);
    // Pas de Content-Type manuel : le navigateur pose la frontière multipart. On garde l'auth native.
    const response = await fetch(`${API_BASE}/api/messages/file`, {
      method: 'POST',
      body: form,
      headers: buildHeaders(false),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(body.error ?? 'Échec de l’envoi du fichier.', response.status);
    }
    return (await response.json()) as Message;
  },

  listChecklists: (equipmentId: string) => request<ChecklistSummary[]>(`/api/equipments/${equipmentId}/checklists`),
  createChecklist: (equipmentId: string, title: string, itemLabels?: string[]) =>
    request<Checklist>('/api/checklists', { method: 'POST', body: JSON.stringify({ equipmentId, title, itemLabels }) }),
  renameChecklist: (id: string, title: string) =>
    request<Checklist>(`/api/checklists/${id}`, { method: 'PUT', body: JSON.stringify({ title }) }),
  deleteChecklist: (id: string) => request<void>(`/api/checklists/${id}`, { method: 'DELETE' }),
  resetChecklist: (id: string) =>
    request<void>(`/api/checklists/${id}/reset`, { method: 'POST', body: JSON.stringify({}) }),

  listChecklistItems: (checklistId: string) => request<ChecklistItem[]>(`/api/checklists/${checklistId}/items`),
  addChecklistItem: (checklistId: string, label: string) =>
    request<ChecklistItem>('/api/checklist-items', { method: 'POST', body: JSON.stringify({ checklistId, label }) }),
  renameChecklistItem: (id: string, label: string) =>
    request<ChecklistItem>(`/api/checklist-items/${id}`, { method: 'PUT', body: JSON.stringify({ label }) }),
  setChecklistItemChecked: (id: string, checked: boolean) =>
    request<ChecklistItem>(`/api/checklist-items/${id}`, { method: 'PUT', body: JSON.stringify({ checked }) }),
  deleteChecklistItem: (id: string) => request<void>(`/api/checklist-items/${id}`, { method: 'DELETE' }),

  listDocuments: (equipmentId: string) => request<EquipmentDocument[]>(`/api/equipments/${equipmentId}/documents`),
  addDocumentLink: (input: { equipmentId: string; url: string; name?: string; category: DocumentCategory }) =>
    request<EquipmentDocument>('/api/documents', { method: 'POST', body: JSON.stringify(input) }),
  updateDocument: (id: string, changes: { name?: string; category?: DocumentCategory }) =>
    request<EquipmentDocument>(`/api/documents/${id}`, { method: 'PUT', body: JSON.stringify(changes) }),
  deleteDocument: (id: string) => request<void>(`/api/documents/${id}`, { method: 'DELETE' }),
  uploadDocument: async (
    file: File,
    meta: { equipmentId: string; category: DocumentCategory; name?: string },
  ): Promise<EquipmentDocument> => {
    const form = new FormData();
    form.append('equipmentId', meta.equipmentId);
    form.append('category', meta.category);
    if (meta.name) form.append('name', meta.name);
    // Le fichier en dernier : la route lit les parties dans l'ordre reçu, et les champs d'abord
    // lui évitent de garder tout le corps en mémoire avant de savoir s'il l'accepte.
    form.append('file', file);
    // Pas de Content-Type manuel : le navigateur pose la frontière multipart. On garde l'auth native.
    const response = await fetch(`${API_BASE}/api/documents/file`, {
      method: 'POST',
      body: form,
      headers: buildHeaders(false),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(body.error ?? 'Échec du dépôt.', response.status);
    }
    return (await response.json()) as EquipmentDocument;
  },

  listNotifications: (unreadOnly = false) =>
    request<AppNotification[]>(`/api/notifications${unreadOnly ? '?unread=1' : ''}`),
  unreadCount: () => request<{ count: number }>('/api/notifications/unread-count'),
  markNotificationRead: (id: string) =>
    request<void>(`/api/notifications/${id}/read`, { method: 'POST', body: JSON.stringify({}) }),
  markAllNotificationsRead: () =>
    request<void>('/api/notifications/read-all', { method: 'POST', body: JSON.stringify({}) }),
  dismissNotification: (id: string) => request<void>(`/api/notifications/${id}`, { method: 'DELETE' }),
  dismissAllNotifications: () => request<void>('/api/notifications', { method: 'DELETE' }),
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
