import type { Member } from '../domain/member/member.js';
import type { MemberCredential } from '../domain/auth/credential.js';
import type { Session } from '../domain/auth/session.js';
import type { Equipment } from '../domain/equipment/equipment.js';
import type { Reservation } from '../domain/reservation/reservation.js';
import type { UsageRecord } from '../domain/usage/usage-record.js';
import type { Expense } from '../domain/expense/expense.js';
import type { Reimbursement } from '../domain/expense/reimbursement.js';

/** Ports de persistance — implémentés par la couche infrastructure. */

export interface MemberRepository {
  findById(id: string): Promise<Member | null>;
  findAll(): Promise<Member[]>;
  save(member: Member): Promise<void>;
}

export interface EquipmentRepository {
  findById(id: string): Promise<Equipment | null>;
  findAll(): Promise<Equipment[]>;
  save(equipment: Equipment): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ReservationRepository {
  findById(id: string): Promise<Reservation | null>;
  findByEquipmentId(equipmentId: string): Promise<Reservation[]>;
  findAll(): Promise<Reservation[]>;
  save(reservation: Reservation): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface UsageRecordRepository {
  findByEquipmentId(equipmentId: string): Promise<UsageRecord[]>;
  findByMemberId(memberId: string): Promise<UsageRecord[]>;
  save(record: UsageRecord): Promise<void>;
}

export interface ExpenseRepository {
  findById(id: string): Promise<Expense | null>;
  findByEquipmentId(equipmentId: string): Promise<Expense[]>;
  save(expense: Expense): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ReimbursementRepository {
  findByEquipmentId(equipmentId: string): Promise<Reimbursement[]>;
  save(reimbursement: Reimbursement): Promise<void>;
}

export interface CredentialRepository {
  findByMemberId(memberId: string): Promise<MemberCredential | null>;
  findByInviteCode(code: string): Promise<MemberCredential | null>;
  count(): Promise<number>;
  save(credential: MemberCredential): Promise<void>;
}

export interface SessionRepository {
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  delete(tokenHash: string): Promise<void>;
  deleteExpired(now: Date): Promise<void>;
}

/** Ports techniques. */

export interface IdGenerator {
  next(): string;
}

export interface Clock {
  now(): Date;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export interface TokenGenerator {
  /** Jeton de session opaque remis au client (jamais stocké en clair). */
  sessionToken(): string;
  /** Code d'invitation court, transmissible hors de l'application. */
  inviteCode(): string;
  /** Empreinte non réversible d'un jeton, seule valeur persistée. */
  hash(token: string): string;
}
