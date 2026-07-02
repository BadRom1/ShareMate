import type { Equipment } from '../equipment/equipment.js';
import type { UsageRecord } from './usage-record.js';

export interface MaintenanceStatus {
  equipmentId: string;
  threshold: number | null;
  /** Dernier relevé de compteur connu (null si aucun relevé). */
  currentReading: number | null;
  /** Compteur à la dernière maintenance déclarée (ou premier relevé connu). */
  lastMaintenanceReading: number | null;
  /** Unités (heures/km) écoulées depuis la dernière maintenance. */
  unitsSinceMaintenance: number | null;
  alert: boolean;
}

/**
 * Règle métier : une alerte d'entretien se déclenche quand le nombre d'unités
 * (heures moteur ou km) écoulées depuis la dernière maintenance déclarée
 * atteint le seuil configuré sur l'équipement. Sans maintenance déclarée,
 * la référence est le premier relevé connu.
 */
export function computeMaintenanceStatus(
  equipment: Equipment,
  records: readonly UsageRecord[],
): MaintenanceStatus {
  const readings = records.map((r) => r.meterReading);
  const currentReading = readings.length > 0 ? Math.max(...readings) : null;

  const maintenanceReadings = records.filter((r) => r.isMaintenance).map((r) => r.meterReading);
  const lastMaintenanceReading =
    maintenanceReadings.length > 0
      ? Math.max(...maintenanceReadings)
      : readings.length > 0
        ? Math.min(...readings)
        : null;

  const unitsSinceMaintenance =
    currentReading !== null && lastMaintenanceReading !== null
      ? currentReading - lastMaintenanceReading
      : null;

  const alert =
    equipment.maintenanceThreshold !== null &&
    unitsSinceMaintenance !== null &&
    unitsSinceMaintenance >= equipment.maintenanceThreshold;

  return {
    equipmentId: equipment.id,
    threshold: equipment.maintenanceThreshold,
    currentReading,
    lastMaintenanceReading,
    unitsSinceMaintenance,
    alert,
  };
}
