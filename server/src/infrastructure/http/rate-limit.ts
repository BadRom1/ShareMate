import type { FastifyRequest } from 'fastify';

/**
 * Plafonds de requêtes par IP, sur une fenêtre glissante d'une minute.
 *
 * Le plafond global couvre toutes les routes — y compris celles qui déclenchent une écriture
 * en lecture, et le front statique. Deux plafonds plus serrés se posent par-dessus : les routes
 * d'authentification publiques (force brute) et les gestes coûteux ou à effet durable.
 *
 * Un troisième compteur, tenu dans `app.ts`, borne le trafic rejeté faute de session : le
 * compteur du greffon est attaché au niveau de la route, donc après la garde de session, et ne
 * voyait jamais passer une requête anonyme sur une route protégée.
 */
export interface RateLimits {
  /** Plafond par défaut de toutes les routes. */
  global: number;
  /** Routes d'authentification publiques : connexion, invitation, amorçage. */
  auth: number;
  /** Création de compte et téléversement : lents, volumineux, ou ouvrant un accès. */
  sensitive: number;
  /** Lecture anonyme touchant la base : bornée sous le global, sans gêner un usage humain. */
  anonymousRead: number;
}

export const RATE_WINDOW = '1 minute';

export const DEFAULT_RATE_LIMITS: RateLimits = { global: 300, auth: 10, sensitive: 20, anonymousRead: 60 };

/** Plafond de route, à poser dans `config.rateLimit`. */
export function limit(max: number) {
  return { max, timeWindow: RATE_WINDOW };
}

/**
 * Compteur par IP **et par route** : sans la route dans la clé, toutes les routes partageraient
 * un même seau et le plafond le plus serré s'appliquerait de fait à toutes.
 * `routeOptions.url` est le gabarit (`/api/equipments/:id`), pas l'URL reçue : deux identifiants
 * distincts ne s'offrent donc pas deux seaux.
 */
export function keyPerRoute(request: FastifyRequest): string {
  return `${request.ip}:${request.routeOptions?.url ?? 'inconnue'}`;
}

/**
 * Message français du dépassement. @fastify/rate-limit **lève** ce que rend le constructeur :
 * il faut une Error portant son `statusCode`, que l'error handler rendra en `{ error }`.
 */
export function tooManyRequests(_request: unknown, context: { ttl: number; statusCode: number }) {
  const seconds = Math.max(1, Math.ceil(context.ttl / 1000));
  const error = new Error(`Trop de requêtes. Réessayez dans ${seconds} seconde${seconds > 1 ? 's' : ''}.`);
  return Object.assign(error, { statusCode: context.statusCode });
}
