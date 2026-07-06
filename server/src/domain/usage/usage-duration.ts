import type { UsageRecord } from './usage-record.js';

/**
 * Durée attribuée à chaque relevé : la différence entre son compteur et le
 * relevé précédent du même équipement. Le tout premier relevé n'a pas de
 * référence (compteur d'origine inconnu) → durée null.
 */
export function computeDurations(records: readonly UsageRecord[]): Map<string, number | null> {
  const ordered = [...records].sort(
    (a, b) => a.meterReading - b.meterReading || a.recordedAt.getTime() - b.recordedAt.getTime(),
  );
  const durations = new Map<string, number | null>();
  let previousReading: number | null = null;
  for (const record of ordered) {
    durations.set(record.id, previousReading === null ? null : record.meterReading - previousReading);
    previousReading = record.meterReading;
  }
  return durations;
}
