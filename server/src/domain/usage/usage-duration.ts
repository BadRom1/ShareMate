import { roundMeterValue } from './meter-value.js';
import type { UsageRecord } from './usage-record.js';

/**
 * Ordre de la chaîne des relevés d'un équipement : compteur croissant, la date
 * départageant deux relevés au même compteur. C'est cet ordre qui donne son sens
 * à « le relevé précédent » — aussi bien pour attribuer les durées que pour borner
 * la correction d'un relevé.
 */
export function chainOrder(a: UsageRecord, b: UsageRecord): number {
  return a.meterReading - b.meterReading || a.recordedAt.getTime() - b.recordedAt.getTime();
}

/**
 * Durée attribuée à chaque relevé : la différence entre son compteur d'arrivée et son
 * compteur de départ. Les relevés antérieurs au compteur de départ n'en portent pas :
 * leur référence reste le relevé précédent du même équipement, comme avant. Sans l'un
 * ni l'autre (tout premier relevé, compteur d'origine inconnu) → durée null.
 */
export function computeDurations(records: readonly UsageRecord[]): Map<string, number | null> {
  const ordered = [...records].sort(chainOrder);
  const durations = new Map<string, number | null>();
  let previousReading: number | null = null;
  for (const record of ordered) {
    const start = record.startReading ?? previousReading;
    durations.set(record.id, start === null ? null : roundMeterValue(record.meterReading - start));
    previousReading = record.meterReading;
  }
  return durations;
}
