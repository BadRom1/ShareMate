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

  it('les décimales restent lisibles : 164 h puis 165,3 h donnent 1,3 h', () => {
    const durations = computeDurations([record('u1', 164), record('u2', 164 + 1.3)]);
    expect(durations.get('u2')).toBe(1.3);
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

  it('le compteur de départ du relevé l’emporte sur le relevé précédent', () => {
    const chaîne = [record('u1', 100), record('u2', 165)];
    const avecDépart = UsageRecord.create({
      id: 'u2',
      equipmentId: 'e1',
      memberId: 'm1',
      recordedAt: new Date('2026-07-02T10:00:00Z'),
      meterReading: 165,
      startReading: 158,
    });
    // Sans départ, les 65 h séparant les deux relevés tomberaient entières sur le second.
    expect(computeDurations(chaîne).get('u2')).toBe(65);
    expect(computeDurations([chaîne[0]!, avecDépart]).get('u2')).toBe(7);
  });

  it('un segment en attente porte sa durée comme un autre', () => {
    const attente = UsageRecord.create({
      id: 'u2',
      equipmentId: 'e1',
      memberId: null,
      recordedAt: new Date('2026-07-02T10:00:00Z'),
      meterReading: 158,
      startReading: 100,
    });
    expect(computeDurations([record('u1', 100), attente]).get('u2')).toBe(58);
  });

  it('liste vide', () => {
    expect(computeDurations([]).size).toBe(0);
  });
});
