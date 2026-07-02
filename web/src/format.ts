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
