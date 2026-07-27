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
 * d'équipement dont il ne fait pas partie.
 */
export class ForbiddenError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** Authentification requise ou identifiants invalides. */
export class UnauthorizedError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}
