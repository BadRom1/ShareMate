export function formatEuros(value: number): string {
  return value.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(iso: string): string {
  return `${formatDate(iso)} ${formatTime(iso)}`;
}

export const CATEGORY_LABELS: Record<string, string> = {
  PURCHASE: 'Achat',
  INSURANCE: 'Assurance',
  FUEL: 'Carburant',
  MAINTENANCE: 'Entretien',
  REPAIR: 'Réparation',
  OTHER: 'Autre',
};

export function meterLabel(unit: 'HOURS' | 'KILOMETERS'): string {
  return unit === 'HOURS' ? 'h' : 'km';
}

export const NOTIFICATION_LABELS: Record<string, string> = {
  MESSAGE_POSTED: 'Nouveau message de discussion',
  EXPENSE_ADDED: 'Nouvelle dépense',
  RESERVATION_CREATED: 'Nouvelle réservation',
  REIMBURSEMENT_RECORDED: 'Remboursement enregistré',
  MAINTENANCE_ALERT: "Alerte d'entretien",
};

/** Date relative courte (« il y a 5 min », « il y a 2 h », sinon date). */
export function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return formatDate(iso);
}
