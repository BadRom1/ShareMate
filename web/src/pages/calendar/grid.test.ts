import { describe, expect, it } from 'vitest';
import {
  dateKey,
  findNextFreeSlot,
  hasPriorityOver,
  monthGridDays,
  overlapping,
  placeDayEvents,
  reservationsByDay,
  reservationsByStartDay,
  startOfWeek,
  timeKey,
  weekDays,
} from './grid';
import { aReservation } from '../../test/factories';

/** Réservation d'un créneau local, comme le serveur la renvoie (ISO UTC). */
function slot(id: string, start: [number, number, number, number], end: [number, number, number, number], over = {}) {
  const [sy, sm, sd, sh] = start;
  const [ey, em, ed, eh] = end;
  return aReservation({
    id,
    start: new Date(sy, sm - 1, sd, sh).toISOString(),
    end: new Date(ey, em - 1, ed, eh).toISOString(),
    ...over,
  });
}

describe('grille mensuelle', () => {
  // Mars 2026 commence un dimanche : la grille démarre le lundi 23 février et il faut six
  // semaines pour contenir les 31 jours.
  it('couvre le mois par semaines entières, du lundi au dimanche', () => {
    const days = monthGridDays(new Date(2026, 2, 1));

    expect(days).toHaveLength(42);
    expect(dateKey(days[0])).toBe('2026-02-23');
    expect(days[0].getDay()).toBe(1);
    expect(dateKey(days[41])).toBe('2026-04-05');
  });

  // Juin 2026 commence un lundi et tient en cinq semaines : aucune ligne de débord inutile.
  it("n'ajoute pas de semaine superflue", () => {
    const days = monthGridDays(new Date(2026, 5, 1));

    expect(days).toHaveLength(35);
    expect(dateKey(days[0])).toBe('2026-06-01');
    expect(dateKey(days[34])).toBe('2026-07-05');
  });

  it('rend sept jours consécutifs à partir du lundi', () => {
    const days = weekDays(startOfWeek(new Date(2026, 2, 4)));

    expect(days.map(dateKey)).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
    ]);
  });

  it('ramène un dimanche au lundi qui le précède', () => {
    expect(dateKey(startOfWeek(new Date(2026, 2, 8)))).toBe('2026-03-02');
    expect(dateKey(startOfWeek(new Date(2026, 2, 2)))).toBe('2026-03-02');
  });

  it("formate les clés de jour et d'heure en heure locale", () => {
    expect(dateKey(new Date(2026, 0, 5, 9, 30))).toBe('2026-01-05');
    expect(timeKey(new Date(2026, 0, 5, 9, 5))).toBe('09:05');
  });
});

describe('répartition par jour', () => {
  it('fait apparaître une réservation à cheval sur chacun de ses jours', () => {
    const multi = slot('r1', [2026, 3, 2, 16], [2026, 3, 4, 10]);

    const byDay = reservationsByDay([multi]);

    expect([...byDay.keys()]).toEqual(['2026-03-02', '2026-03-03', '2026-03-04']);
  });

  // Le dernier jour n'est retenu que si la réservation y déborde vraiment : une fin à minuit
  // pile appartient à la veille.
  it('exclut le jour où la réservation se termine à minuit', () => {
    const byDay = reservationsByDay([slot('r1', [2026, 3, 2, 8], [2026, 3, 3, 0])]);

    expect([...byDay.keys()]).toEqual(['2026-03-02']);
  });

  it('groupe la vue liste par jour de début', () => {
    const groups = reservationsByStartDay([
      slot('r1', [2026, 3, 2, 8], [2026, 3, 2, 10]),
      slot('r2', [2026, 3, 2, 14], [2026, 3, 2, 16]),
      slot('r3', [2026, 3, 3, 8], [2026, 3, 3, 9]),
    ]);

    expect(groups.map(([day, rs]) => [day, rs.map((r) => r.id)])).toEqual([
      ['2026-03-02', ['r1', 'r2']],
      ['2026-03-03', ['r3']],
    ]);
  });
});

describe('placement dans la vue semaine', () => {
  const hours = { start: 6, end: 22 };
  const day = new Date(2026, 2, 2);

  it('positionne un créneau en pourcentage de la plage affichée', () => {
    const { placed, laneCount } = placeDayEvents(day, [slot('r1', [2026, 3, 2, 10], [2026, 3, 2, 14])], hours);

    expect(laneCount).toBe(1);
    expect(placed[0].top).toBeCloseTo(25); // 10 h, soit 4 h après 6 h sur 16 h affichées
    expect(placed[0].height).toBeCloseTo(25);
  });

  it('met côte à côte les réservations qui se chevauchent', () => {
    const { placed, laneCount } = placeDayEvents(
      day,
      [slot('r1', [2026, 3, 2, 8], [2026, 3, 2, 12]), slot('r2', [2026, 3, 2, 10], [2026, 3, 2, 14])],
      hours,
    );

    expect(laneCount).toBe(2);
    expect(placed.map((p) => p.lane)).toEqual([0, 1]);
  });

  it('réutilise une colonne libérée par un créneau terminé', () => {
    const { placed, laneCount } = placeDayEvents(
      day,
      [slot('r1', [2026, 3, 2, 8], [2026, 3, 2, 10]), slot('r2', [2026, 3, 2, 10], [2026, 3, 2, 12])],
      hours,
    );

    expect(laneCount).toBe(1);
    expect(placed.map((p) => p.lane)).toEqual([0, 0]);
  });

  it('borne un créneau qui déborde de la plage affichée', () => {
    const { placed } = placeDayEvents(day, [slot('r1', [2026, 3, 1, 20], [2026, 3, 3, 8])], hours);

    expect(placed[0].top).toBe(0);
    expect(placed[0].height).toBe(100);
  });

  it('garde une hauteur minimale visible pour un créneau très court', () => {
    const { placed } = placeDayEvents(
      day,
      [aReservation({ start: new Date(2026, 2, 2, 10).toISOString(), end: new Date(2026, 2, 2, 10, 5).toISOString() })],
      hours,
    );

    expect(placed[0].height).toBe(4);
  });

  it("ignore les réservations d'un autre jour", () => {
    const { placed, laneCount } = placeDayEvents(day, [slot('r1', [2026, 3, 3, 8], [2026, 3, 3, 10])], hours);

    expect(placed).toHaveLength(0);
    expect(laneCount).toBe(1);
  });
});

describe('conflits', () => {
  it('ne compte pas comme conflit deux créneaux bout à bout', () => {
    const existing = [slot('r1', [2026, 3, 2, 8], [2026, 3, 2, 10])];

    expect(overlapping(new Date(2026, 2, 2, 10), new Date(2026, 2, 2, 12), existing)).toHaveLength(0);
    expect(overlapping(new Date(2026, 2, 2, 9), new Date(2026, 2, 2, 12), existing)).toHaveLength(1);
  });

  it("fait primer l'obligatoire sur le prévisionnel", () => {
    const requis = aReservation({ id: 'r1', status: 'REQUIRED', createdAt: '2026-03-02T00:00:00.000Z' });
    const prevu = aReservation({ id: 'r2', status: 'PLANNED', createdAt: '2026-03-01T00:00:00.000Z' });

    expect(hasPriorityOver(requis, prevu)).toBe(true);
    expect(hasPriorityOver(prevu, requis)).toBe(false);
  });

  it('départage deux créneaux de même type par ordre de création', () => {
    const premier = aReservation({ id: 'r1', createdAt: '2026-03-01T00:00:00.000Z' });
    const second = aReservation({ id: 'r2', createdAt: '2026-03-02T00:00:00.000Z' });

    expect(hasPriorityOver(premier, second)).toBe(true);
    expect(hasPriorityOver(second, premier)).toBe(false);
  });
});

describe('suggestion de créneau libre', () => {
  it('propose le créneau demandé lui-même quand rien ne le bloque', () => {
    const suggestion = findNextFreeSlot(new Date(2026, 2, 2, 8), new Date(2026, 2, 2, 10), []);

    expect(suggestion && dateKey(suggestion.start)).toBe('2026-03-02');
    expect(suggestion && timeKey(suggestion.start)).toBe('08:00');
  });

  it('décale après la réservation bloquante, en conservant la durée', () => {
    const existing = [slot('r1', [2026, 3, 2, 8], [2026, 3, 2, 12])];

    const suggestion = findNextFreeSlot(new Date(2026, 2, 2, 9), new Date(2026, 2, 2, 11), existing);

    expect(suggestion && timeKey(suggestion.start)).toBe('12:00');
    expect(suggestion && timeKey(suggestion.end)).toBe('14:00');
  });

  // Deux réservations qui se suivent : le premier saut tombe encore dans la seconde, il faut
  // repartir de la fin la plus tardive jusqu'à trouver un vrai trou.
  it('enjambe une suite de réservations contiguës', () => {
    const existing = [slot('r1', [2026, 3, 2, 8], [2026, 3, 2, 12]), slot('r2', [2026, 3, 2, 12], [2026, 3, 2, 15])];

    const suggestion = findNextFreeSlot(new Date(2026, 2, 2, 9), new Date(2026, 2, 2, 10), existing);

    expect(suggestion && timeKey(suggestion.start)).toBe('15:00');
  });
});
