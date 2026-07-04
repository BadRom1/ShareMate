import { describe, expect, it } from 'vitest';
import { UsageRecord } from './usage-record.js';
import { computeDurations } from './usage-duration.js';

function record(id: string, meterReading: number, recordedAt = '2026-07-02T10:00:00Z'): UsageRecord {
  return UsageRecord.create({
    id,
    equipmentId: 'e1',
    memberId: 'm1',
    recordedAt: new Date(recordedAt),
    meterReading,
  });
}

describe('computeDurations', () => {
  it('attribue à chaque relevé le delta avec le relevé précédent', () => {
    const durations = computeDurations([record('u2', 110), record('u1', 100), record('u3', 112.5)]);
    expect(durations.get('u1')).toBeNull();
    expect(durations.get('u2')).toBe(10);
    expect(durations.get('u3')).toBe(2.5);
  });

  it('le premier relevé n’a pas de durée (compteur d’origine inconnu)', () => {
    const durations = computeDurations([record('u1', 1200)]);
    expect(durations.get('u1')).toBeNull();
  });

  it('relevés à compteur égal : départagés par la date, durée nulle', () => {
    const durations = computeDurations([
      record('u2', 100, '2026-07-03T10:00:00Z'),
      record('u1', 100, '2026-07-02T10:00:00Z'),
    ]);
    expect(durations.get('u1')).toBeNull();
    expect(durations.get('u2')).toBe(0);
  });

  it('liste vide', () => {
    expect(computeDurations([]).size).toBe(0);
  });
});
