import type { Member } from '../domain/member/member.js';
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

/** Ports techniques. */

export interface IdGenerator {
  next(): string;
}

export interface Clock {
  now(): Date;
}
