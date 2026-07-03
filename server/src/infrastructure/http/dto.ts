import type { Group } from '../../domain/group/group.js';
import type { Member } from '../../domain/group/member.js';
import type { Equipment } from '../../domain/equipment/equipment.js';
import type { Reservation } from '../../domain/reservation/reservation.js';
import { conflictMap } from '../../domain/reservation/reservation-conflict.js';
import type { UsageRecord } from '../../domain/usage/usage-record.js';
import type { Expense, SplitRule } from '../../domain/expense/expense.js';
import type { Reimbursement } from '../../domain/expense/reimbursement.js';

/** Mappers entité → JSON de l'API. */

export function memberDto(m: Member) {
  return { id: m.id, name: m.name, email: m.email };
}

export function groupDto(g: Group) {
  return { id: g.id, name: g.name, memberIds: g.memberIds };
}

export function equipmentDto(e: Equipment) {
  return {
    id: e.id,
    groupId: e.groupId,
    name: e.name,
    category: e.category,
    acquisitionDate: e.acquisitionDate.toISOString(),
    purchaseValueEuros: e.purchaseValue.toEuros(),
    meterUnit: e.meterUnit,
    accessMemberIds: e.accessMemberIds,
    maintenanceThreshold: e.maintenanceThreshold,
  };
}

export function reservationDto(r: Reservation, conflictIds: string[] = []) {
  return {
    id: r.id,
    equipmentId: r.equipmentId,
    memberId: r.memberId,
    start: r.range.start.toISOString(),
    end: r.range.end.toISOString(),
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    conflictIds,
    notes: r.notes,
  };
}

/** Liste de réservations annotées de leurs conflits mutuels. */
export function reservationListDto(list: Reservation[]) {
  const conflicts = conflictMap(list);
  return list.map((r) => reservationDto(r, conflicts.get(r.id)));
}

export function usageRecordDto(u: UsageRecord) {
  return {
    id: u.id,
    equipmentId: u.equipmentId,
    memberId: u.memberId,
    recordedAt: u.recordedAt.toISOString(),
    meterReading: u.meterReading,
    fuelAddedLiters: u.fuelAddedLiters,
    notes: u.notes,
    isMaintenance: u.isMaintenance,
  };
}

function splitDto(split: SplitRule) {
  if (split.type === 'CUSTOM') {
    return {
      type: 'CUSTOM' as const,
      amountsEuros: Object.fromEntries(Object.entries(split.amounts).map(([k, v]) => [k, v.toEuros()])),
    };
  }
  return split;
}

export function expenseDto(x: Expense) {
  return {
    id: x.id,
    groupId: x.groupId,
    equipmentId: x.equipmentId,
    label: x.label,
    amountEuros: x.amount.toEuros(),
    payerId: x.payerId,
    date: x.date.toISOString(),
    category: x.category,
    split: splitDto(x.split),
    receiptPath: x.receiptPath,
    sharesEuros: Object.fromEntries([...x.shares()].map(([memberId, share]) => [memberId, share.toEuros()])),
  };
}

export function reimbursementDto(r: Reimbursement) {
  return {
    id: r.id,
    groupId: r.groupId,
    fromMemberId: r.fromMemberId,
    toMemberId: r.toMemberId,
    amountEuros: r.amount.toEuros(),
    date: r.date.toISOString(),
    notes: r.notes,
  };
}
