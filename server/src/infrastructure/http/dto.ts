import type { Member } from '../../domain/member/member.js';
import type { Equipment } from '../../domain/equipment/equipment.js';
import type { Reservation } from '../../domain/reservation/reservation.js';
import { conflictMap } from '../../domain/reservation/reservation-conflict.js';
import type { UsageRecord } from '../../domain/usage/usage-record.js';
import type { Expense, SplitRule } from '../../domain/expense/expense.js';
import type { Reimbursement } from '../../domain/expense/reimbursement.js';
import type { Message } from '../../domain/discussion/message.js';
import type { Thread } from '../../domain/discussion/thread.js';
import type { ThreadSummary } from '../../application/discussion-service.js';
import type { Notification } from '../../domain/notification/notification.js';
import type { NotificationPreference } from '../../domain/notification/preference.js';

/** Mappers entité → JSON de l'API. */

export function memberDto(m: Member) {
  return { id: m.id, name: m.name, email: m.email };
}

export function equipmentDto(e: Equipment) {
  return {
    id: e.id,
    name: e.name,
    category: e.category,
    acquisitionDate: e.acquisitionDate.toISOString(),
    purchaseValueEuros: e.purchaseValue.toEuros(),
    meterUnit: e.meterUnit,
    memberIds: e.memberIds,
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

export function usageRecordDto(u: UsageRecord, duration: number | null = null) {
  return {
    id: u.id,
    equipmentId: u.equipmentId,
    memberId: u.memberId,
    recordedAt: u.recordedAt.toISOString(),
    meterReading: u.meterReading,
    duration,
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
    equipmentId: r.equipmentId,
    fromMemberId: r.fromMemberId,
    toMemberId: r.toMemberId,
    amountEuros: r.amount.toEuros(),
    date: r.date.toISOString(),
    notes: r.notes,
  };
}

export function threadDto(t: Thread) {
  return {
    id: t.id,
    equipmentId: t.equipmentId,
    authorId: t.authorId,
    title: t.title,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function threadSummaryDto(s: ThreadSummary) {
  return { ...threadDto(s.thread), messageCount: s.messageCount };
}

export function messageDto(m: Message) {
  return {
    id: m.id,
    threadId: m.threadId,
    authorId: m.authorId,
    body: m.body,
    createdAt: m.createdAt.toISOString(),
    editedAt: m.editedAt ? m.editedAt.toISOString() : null,
    parentId: m.parentId,
  };
}

export function notificationDto(n: Notification) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    createdAt: n.createdAt.toISOString(),
    readAt: n.readAt ? n.readAt.toISOString() : null,
  };
}

export function preferenceDto(p: NotificationPreference) {
  return { type: p.type, inApp: p.inApp, push: p.push };
}
