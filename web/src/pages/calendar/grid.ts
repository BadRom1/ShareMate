/**
 * Calculs de grille du calendrier partagé : découpage en jours, placement des réservations et
 * arbitrage des conflits. Fonctions pures, sans état ni appel réseau — c'est du code dont une
 * régression ne se voit pas à l'œil nu sur un mois donné.
 */
import type { Reservation } from '../../api';

/** Clé de jour (`2026-03-02`), en heure locale : les jours affichés sont ceux du membre. */
export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function timeKey(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Lundi de la semaine contenant `d`, à minuit. */
export function startOfWeek(d: Date): Date {
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

/**
 * Jours de la grille mensuelle : semaines entières (lundi → dimanche) couvrant tout le mois,
 * débords des mois voisins compris. Le nombre de semaines s'adapte (4 à 6), pour ne pas laisser
 * une ligne vide en fin de grille.
 */
export function monthGridDays(month: Date): Date[] {
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = startOfWeek(firstDay);
  const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const weeksNeeded = Math.ceil((((firstDay.getDay() + 6) % 7) + lastDay.getDate()) / 7);
  const days: Date[] = [];
  const cursor = new Date(gridStart);
  while (days.length < weeksNeeded * 7) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

/** Les sept jours de la semaine commençant à `weekStart`. */
export function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });
}

/**
 * Réservations par jour occupé : une réservation à cheval sur plusieurs jours apparaît sur
 * chacun d'eux, sinon elle disparaîtrait de la grille dès le lendemain de son début.
 */
export function reservationsByDay(reservations: Reservation[]): Map<string, Reservation[]> {
  const map = new Map<string, Reservation[]>();
  for (const r of reservations) {
    const start = new Date(r.start);
    const end = new Date(r.end);
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    while (cursor < end) {
      const key = dateKey(cursor);
      map.set(key, [...(map.get(key) ?? []), r]);
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return map;
}

/** Réservations groupées par jour de début, dans l'ordre d'arrivée (vue liste). */
export function reservationsByStartDay(reservations: Reservation[]): [string, Reservation[]][] {
  const map = new Map<string, Reservation[]>();
  for (const r of reservations) {
    const day = dateKey(new Date(r.start));
    map.set(day, [...(map.get(day) ?? []), r]);
  }
  return [...map.entries()];
}

export interface PlacedEvent {
  reservation: Reservation;
  /** Colonne d'affichage : les réservations qui se chevauchent sont côte à côte. */
  lane: number;
  /** Position et hauteur en pourcentage de la plage horaire affichée. */
  top: number;
  height: number;
}

/**
 * Place les réservations d'un jour dans la vue semaine, bornées à la plage horaire affichée.
 * Hauteur minimale de 4 % : un créneau de quelques minutes doit rester cliquable.
 */
export function placeDayEvents(
  day: Date,
  reservations: Reservation[],
  hours: { start: number; end: number },
): { placed: PlacedEvent[]; laneCount: number } {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours.start);
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours.end);
  const total = dayEnd.getTime() - dayStart.getTime();
  const events = reservations
    .filter((r) => new Date(r.start) < dayEnd && dayStart < new Date(r.end))
    .sort((a, b) => a.start.localeCompare(b.start));

  const laneEnds: number[] = [];
  const placed = events.map((r) => {
    const start = Math.max(new Date(r.start).getTime(), dayStart.getTime());
    const end = Math.min(new Date(r.end).getTime(), dayEnd.getTime());
    let lane = laneEnds.findIndex((e) => e <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    return {
      reservation: r,
      lane,
      top: ((start - dayStart.getTime()) / total) * 100,
      height: Math.max(((end - start) / total) * 100, 4),
    };
  });
  return { placed, laneCount: Math.max(laneEnds.length, 1) };
}

/** Priorité en cas de conflit : l'obligatoire prime sur le prévisionnel, sinon le premier créé. */
export function hasPriorityOver(a: Reservation, b: Reservation): boolean {
  if (a.status !== b.status) return a.status === 'REQUIRED';
  return a.createdAt < b.createdAt;
}

/** Réservations chevauchant le créneau demandé (bornes exclues : deux créneaux bout à bout vont). */
export function overlapping(start: Date, end: Date, reservations: Reservation[]): Reservation[] {
  return reservations.filter((r) => new Date(r.start) < end && start < new Date(r.end));
}

/** Nombre maximal de créneaux essayés avant d'abandonner la suggestion. */
const MAX_SLOT_ATTEMPTS = 200;

/** Premier créneau libre de même durée à partir du créneau demandé, `null` si aucun. */
export function findNextFreeSlot(
  start: Date,
  end: Date,
  reservations: Reservation[],
): { start: Date; end: Date } | null {
  const duration = end.getTime() - start.getTime();
  let candidateStart = start.getTime();
  for (let i = 0; i < MAX_SLOT_ATTEMPTS; i += 1) {
    const candidateEnd = candidateStart + duration;
    const blocking = overlapping(new Date(candidateStart), new Date(candidateEnd), reservations);
    if (blocking.length === 0) {
      return { start: new Date(candidateStart), end: new Date(candidateEnd) };
    }
    candidateStart = Math.max(...blocking.map((r) => new Date(r.end).getTime()));
  }
  return null;
}
