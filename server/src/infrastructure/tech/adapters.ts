import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { Clock, IdGenerator, PasswordHasher, TokenGenerator } from '../../application/ports.js';

export class UuidGenerator implements IdGenerator {
  next(): string {
    return crypto.randomUUID();
  }
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

const scrypt = promisify<crypto.BinaryLike, crypto.BinaryLike, number, crypto.ScryptOptions, Buffer>(crypto.scrypt);

/** Paramètres de coût d'une dérivation scrypt. */
export interface ScryptCost {
  /** Facteur de coût CPU/mémoire, puissance de deux. */
  N: number;
  /** Taille de bloc. */
  r: number;
  /** Parallélisation. */
  p: number;
}

/** Recommandation OWASP pour scrypt (N ≥ 2¹⁷). ~128 Mio et ~0,3 s par dérivation. */
export const CURRENT_COST: ScryptCost = { N: 2 ** 17, r: 8, p: 1 };

/**
 * Coût implicite des hachages au format hérité `scrypt:<sel>:<dérivé>` : ce sont les défauts de
 * Node, jamais écrits nulle part. Les relire suppose de les figer ici — c'est précisément ce que
 * le format versionné évite pour la suite.
 */
const LEGACY_COST: ScryptCost = { N: 16384, r: 8, p: 1 };

const LONGUEUR_SEL = 16;
const LONGUEUR_DÉRIVÉE = 32;

/**
 * Node refuse la dérivation dès que 128 × N × r dépasse `maxmem` (32 Mio par défaut, largement
 * sous les 128 Mio de N = 2¹⁷). Le facteur 2 laisse la marge que la vérification interne exige.
 */
function maxmem(cost: ScryptCost): number {
  return 128 * cost.N * cost.r * 2;
}

interface ParsedHash {
  cost: ScryptCost;
  salt: string;
  derived: Buffer;
}

function entierPositif(valeur: string | undefined): number | null {
  const n = Number.parseInt(valeur ?? '', 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Analyse un hachage stocké, dans le format versionné comme dans le format hérité. */
function parseHash(stored: string): ParsedHash | null {
  const champs = stored.split('$');
  if (champs.length === 6 && champs[0] === 'scrypt') {
    const [, n, r, p, salt, derived] = champs;
    const cost = { N: entierPositif(n), r: entierPositif(r), p: entierPositif(p) };
    if (cost.N === null || cost.r === null || cost.p === null || !salt || !derived) {
      return null;
    }
    return { cost: cost as ScryptCost, salt, derived: Buffer.from(derived, 'hex') };
  }
  const [schéma, salt, derived] = stored.split(':');
  if (schéma !== 'scrypt' || !salt || !derived) {
    return null;
  }
  return { cost: LEGACY_COST, salt, derived: Buffer.from(derived, 'hex') };
}

/**
 * Hachage de mots de passe au format versionné `scrypt$N$r$p$sel$dérivé`, qui porte son coût :
 * durcir les paramètres n'invalide plus les hachages existants, `verify` les relit sous leur
 * propre coût et `needsRehash` signale ceux à refaire (voir `AuthService.login`).
 * Le format hérité `scrypt:<sel>:<dérivé>` reste accepté en lecture le temps de la transition.
 */
export class ScryptPasswordHasher implements PasswordHasher {
  constructor(private readonly cost: ScryptCost = CURRENT_COST) {}

  private derive(password: string, salt: string, cost: ScryptCost): Promise<Buffer> {
    return scrypt(password, salt, LONGUEUR_DÉRIVÉE, { ...cost, maxmem: maxmem(cost) });
  }

  async hash(password: string): Promise<string> {
    const salt = crypto.randomBytes(LONGUEUR_SEL).toString('hex');
    const derived = await this.derive(password, salt, this.cost);
    return `scrypt$${this.cost.N}$${this.cost.r}$${this.cost.p}$${salt}$${derived.toString('hex')}`;
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = parseHash(stored);
    if (!parsed) {
      return false;
    }
    const derived = await this.derive(password, parsed.salt, parsed.cost);
    return derived.length === parsed.derived.length && crypto.timingSafeEqual(derived, parsed.derived);
  }

  /** Hachage produit sous un coût inférieur au coût courant : à refaire dès que possible. */
  needsRehash(stored: string): boolean {
    const parsed = parseHash(stored);
    // Illisible : `verify` le rejettera, aucune connexion n'atteindra le re-hachage.
    if (!parsed) {
      return false;
    }
    return parsed.cost.N < this.cost.N || parsed.cost.r < this.cost.r || parsed.cost.p < this.cost.p;
  }
}

export class CryptoTokenGenerator implements TokenGenerator {
  sessionToken(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  inviteCode(): string {
    return crypto.randomBytes(9).toString('base64url');
  }

  hash(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
