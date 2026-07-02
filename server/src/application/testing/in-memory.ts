import type {
  Clock,
  EquipmentRepository,
  ExpenseRepository,
  GroupRepository,
  IdGenerator,
  MemberRepository,
  ReimbursementRepository,
  ReservationRepository,
  UsageRecordRepository,
} from '../ports.js';
import type { Group } from '../../domain/group/group.js';
import type { Member } from '../../domain/group/member.js';
import type { Equipment } from '../../domain/equipment/equipment.js';
import type { Reservation } from '../../domain/reservation/reservation.js';
import type { UsageRecord } from '../../domain/usage/usage-record.js';
import type { Expense } from '../../domain/expense/expense.js';
import type { Reimbursement } from '../../domain/expense/reimbursement.js';

/** Adapters in-memory pour les tests (doubles des ports de persistance). */

export class InMemoryGroupRepository implements GroupRepository {
  private items = new Map<string, Group>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findAll() {
    return [...this.items.values()];
  }
  async save(group: Group) {
    this.items.set(group.id, group);
  }
}

export class InMemoryMemberRepository implements MemberRepository {
  private items = new Map<string, Member>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findAll() {
    return [...this.items.values()];
  }
  async save(member: Member) {
    this.items.set(member.id, member);
  }
}

export class InMemoryEquipmentRepository implements EquipmentRepository {
  private items = new Map<string, Equipment>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByGroupId(groupId: string) {
    return [...this.items.values()].filter((e) => e.groupId === groupId);
  }
  async save(equipment: Equipment) {
    this.items.set(equipment.id, equipment);
  }
  async delete(id: string) {
    this.items.delete(id);
  }
}

export class InMemoryReservationRepository implements ReservationRepository {
  private items = new Map<string, Reservation>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByEquipmentId(equipmentId: string) {
    return [...this.items.values()].filter((r) => r.equipmentId === equipmentId);
  }
  async findByEquipmentIds(equipmentIds: string[]) {
    return [...this.items.values()].filter((r) => equipmentIds.includes(r.equipmentId));
  }
  async save(reservation: Reservation) {
    this.items.set(reservation.id, reservation);
  }
  async delete(id: string) {
    this.items.delete(id);
  }
}

export class InMemoryUsageRecordRepository implements UsageRecordRepository {
  private items = new Map<string, UsageRecord>();
  async findByEquipmentId(equipmentId: string) {
    return [...this.items.values()].filter((u) => u.equipmentId === equipmentId);
  }
  async findByMemberId(memberId: string) {
    return [...this.items.values()].filter((u) => u.memberId === memberId);
  }
  async save(record: UsageRecord) {
    this.items.set(record.id, record);
  }
}

export class InMemoryExpenseRepository implements ExpenseRepository {
  private items = new Map<string, Expense>();
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByGroupId(groupId: string) {
    return [...this.items.values()].filter((x) => x.groupId === groupId);
  }
  async save(expense: Expense) {
    this.items.set(expense.id, expense);
  }
  async delete(id: string) {
    this.items.delete(id);
  }
}

export class InMemoryReimbursementRepository implements ReimbursementRepository {
  private items = new Map<string, Reimbursement>();
  async findByGroupId(groupId: string) {
    return [...this.items.values()].filter((r) => r.groupId === groupId);
  }
  async save(reimbursement: Reimbursement) {
    this.items.set(reimbursement.id, reimbursement);
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;
  constructor(private readonly prefix = 'id') {}
  next() {
    this.counter += 1;
    return `${this.prefix}-${this.counter}`;
  }
}

export class FixedClock implements Clock {
  constructor(private date: Date) {}
  now() {
    return this.date;
  }
  set(date: Date) {
    this.date = date;
  }
}
