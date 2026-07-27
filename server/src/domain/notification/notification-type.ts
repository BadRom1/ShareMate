/** Types d'événements notifiables. Union extensible : ajouter un type ici, son libellé au front. */
export type NotificationType =
  | 'MESSAGE_POSTED'
  | 'EXPENSE_ADDED'
  | 'RESERVATION_CREATED'
  | 'REIMBURSEMENT_RECORDED'
  | 'MAINTENANCE_ALERT'
  | 'EQUIPMENT_CIRCLE_CHANGED';

/** Tous les types connus, dans l'ordre d'affichage des préférences. */
export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  'MESSAGE_POSTED',
  'EXPENSE_ADDED',
  'RESERVATION_CREATED',
  'REIMBURSEMENT_RECORDED',
  'MAINTENANCE_ALERT',
  'EQUIPMENT_CIRCLE_CHANGED',
];
