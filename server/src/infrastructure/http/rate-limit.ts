import type { FastifyRequest } from 'fastify';

/**
 * Plafonds de requêtes par IP et par route, sur une fenêtre glissante d'une minute.
 *
 * Le plafond est posé par **un hook unique à la racine** (voir `app.ts`), et non par le mode
 * global du greffon ni route par route. La raison est un ordre de hooks : @fastify/rate-limit
 * attache son compteur au niveau de la route, or un hook de route s'exécute après les hooks de
 * contexte — donc après la garde de session du périmètre protégé. Une requête anonyme sur une
 * route protégée était rejetée en 401 avant d'avoir été comptée, et n'était donc bornée par rien.
 * Le greffon refuse par ailleurs de compter deux fois la même requête (`rateLimitRan`) : empiler
 * un hook racine *et* des plafonds par route désactive silencieusement les seconds. D'où un seul
 * point de comptage, qui choisit son plafond selon la route.
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

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Plafond propre à cette route, en requêtes par minute. Absent = plafond global.
     * Volontairement distinct de `config.rateLimit`, que le greffon intercepterait pour poser
     * son propre hook de route — celui-là même que ce dispositif remplace.
     */
    limitPerMinute?: number;
  }
}

/** Plafond de cette route, ou le plafond global à défaut. */
export function maxFor(limits: RateLimits): (request: FastifyRequest) => number {
  return (request) => request.routeOptions?.config?.limitPerMinute ?? limits.global;
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
