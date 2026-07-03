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

const scrypt = promisify<crypto.BinaryLike, crypto.BinaryLike, number, Buffer>(crypto.scrypt);

/** Hachage de mots de passe au format `scrypt:<sel>:<dérivé>`. */
export class ScryptPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = await scrypt(password, salt, 32);
    return `scrypt:${salt}:${derived.toString('hex')}`;
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const [scheme, salt, expected] = stored.split(':');
    if (scheme !== 'scrypt' || !salt || !expected) {
      return false;
    }
    const derived = await scrypt(password, salt, 32);
    const expectedBuffer = Buffer.from(expected, 'hex');
    return derived.length === expectedBuffer.length && crypto.timingSafeEqual(derived, expectedBuffer);
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
