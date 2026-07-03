import { Group } from '../../domain/group/group.js';
import { Member } from '../../domain/group/member.js';
import { Equipment } from '../../domain/equipment/equipment.js';
import { Money } from '../../domain/shared/money.js';
import {
  FixedClock,
  InMemoryEquipmentRepository,
  InMemoryExpenseRepository,
  InMemoryGroupRepository,
  InMemoryMemberRepository,
  InMemoryReimbursementRepository,
  InMemoryReservationRepository,
  InMemoryUsageRecordRepository,
  SequentialIdGenerator,
} from './in-memory.js';

/** Contexte de test : groupe g1 (m1, m2, m3) + minipelle e1 accessible à m1/m2. */
export async function makeFixture() {
  const groups = new InMemoryGroupRepository();
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
  await groups.save(Group.create({ id: 'g1', name: 'Les voisins', memberIds: ['m1', 'm2', 'm3'] }));
  await equipments.save(
    Equipment.create({
      id: 'e1',
      groupId: 'g1',
      name: 'Minipelle',
      category: 'BTP',
      acquisitionDate: new Date('2025-01-01'),
      purchaseValue: Money.fromEuros(15000),
      meterUnit: 'HOURS',
      accessMemberIds: ['m1', 'm2'],
      maintenanceThreshold: 50,
    }),
  );

  return {
    groups,
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
