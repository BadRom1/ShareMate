import { Member } from '../../domain/member/member.js';
import { Equipment } from '../../domain/equipment/equipment.js';
import { Money } from '../../domain/shared/money.js';
import {
  FixedClock,
  InMemoryEquipmentRepository,
  InMemoryExpenseRepository,
  InMemoryMemberRepository,
  InMemoryReimbursementRepository,
  InMemoryReservationRepository,
  InMemoryUsageRecordRepository,
  SequentialIdGenerator,
} from './in-memory.js';

/** Contexte de test : membres m1, m2, m3 + minipelle e1 dont le cercle est m1/m2. */
export async function makeFixture() {
  const members = new InMemoryMemberRepository();
  const equipments = new InMemoryEquipmentRepository();
  const reservations = new InMemoryReservationRepository();
  const usageRecords = new InMemoryUsageRecordRepository();
  const expenses = new InMemoryExpenseRepository();
  const reimbursements = new InMemoryReimbursementRepository();
  const idGenerator = new SequentialIdGenerator();
  const clock = new FixedClock(new Date('2026-07-02T10:00:00Z'));

  await members.save(Member.create({ id: 'm1', name: 'Alice' }));
  await members.save(Member.create({ id: 'm2', name: 'Bruno' }));
  await members.save(Member.create({ id: 'm3', name: 'Chloé' }));
  await equipments.save(
    Equipment.create({
      id: 'e1',
      name: 'Minipelle',
      category: 'BTP',
      acquisitionDate: new Date('2025-01-01'),
      purchaseValue: Money.fromEuros(15000),
      meterUnit: 'HOURS',
      memberIds: ['m1', 'm2'],
      maintenanceThreshold: 50,
    }),
  );

  return {
    members,
    equipments,
    reservations,
    usageRecords,
    expenses,
    reimbursements,
    idGenerator,
    clock,
  };
}
