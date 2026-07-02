import crypto from 'node:crypto';
import type { Clock, IdGenerator } from '../../application/ports.js';

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
