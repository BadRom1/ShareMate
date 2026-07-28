import { DomainError } from './domain-error.js';

/** Jour seul `AAAA-MM-JJ`, ou préfixe d'un instant ISO : la partie que `new Date` reporte. */
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
}

/**
 * Date d'une saisie utilisateur, refusée si elle ne désigne aucun instant réel.
 *
 * `new Date` ne refuse rien de ce que le motif ISO du schéma HTTP laisse passer, et se trompe de
 * deux façons opposées : une forme illisible (`0000-00-00`) donne une Invalid Date qui ne casse
 * qu'à la sérialisation, très loin de l'entrée — un 500 sur un corps de requête ; un jour qui
 * n'existe pas (`2026-02-31`) est reporté en silence sur le mois suivant, et la donnée enregistrée
 * n'est alors pas celle qui a été saisie. La validité calendaire ne peut se vérifier que sur le
 * texte : elle se fait ici, une fois, avant que la date n'entre dans le domaine.
 *
 * Les composantes sont comparées telles qu'écrites, sans repasser par `Date` : selon la présence
 * d'un fuseau dans la chaîne, l'instant est interprété en UTC ou en heure locale, et relire ses
 * composantes ferait dépendre la validation du fuseau du serveur.
 */
export function parseIsoDate(value: string, subject: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new DomainError(`${subject} n’est pas une date valide : ${value}`);
  }
  const day = CALENDAR_DAY.exec(value);
  if (day) {
    const [year, month, dayOfMonth] = [Number(day[1]), Number(day[2]), Number(day[3])];
    if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > daysInMonth(year, month)) {
      throw new DomainError(`${subject} désigne un jour qui n’existe pas : ${value}`);
    }
  }
  return date;
}

/** Garde-fou des entités : une Invalid Date ne doit jamais entrer dans le domaine. */
export function assertValidDate(date: Date, subject: string): void {
  if (Number.isNaN(date.getTime())) {
    throw new DomainError(`${subject} n’est pas une date valide.`);
  }
}
