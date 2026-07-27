/** Erreur métier : violation d'une règle du domaine. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

/** Erreur de conflit (ex. chevauchement de réservation). */
export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** Ressource introuvable. */
export class NotFoundError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Accès refusé à un membre authentifié : la ressource appartient à un cercle
 * d'équipement dont il ne fait pas partie. Refus **masqué** — rendu en 404, pour ne pas
 * confirmer l'existence de la ressource (voir AuthorizationError pour le refus assumé).
 */
export class ForbiddenError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Geste refusé à un membre authentifié qui voit pourtant la ressource : elle est dans son
 * cercle, mais réservée à son auteur. Rendu en 403 — et non en 401, qui signifie « session
 * absente ou expirée » et fait retomber le client sur l'écran de connexion.
 */
export class AuthorizationError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

/** Authentification requise ou identifiants invalides. */
export class UnauthorizedError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}
