/** Types d'événements notifiables. Union extensible : ajouter un type + son libellé ici. */
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

/** Libellé FR de chaque type, pour l'écran de préférences. */
export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  MESSAGE_POSTED: 'Nouveau message de discussion',
  EXPENSE_ADDED: 'Nouvelle dépense',
  RESERVATION_CREATED: 'Nouvelle réservation',
  REIMBURSEMENT_RECORDED: 'Remboursement enregistré',
  MAINTENANCE_ALERT: "Alerte d'entretien",
  EQUIPMENT_CIRCLE_CHANGED: "Changement dans le cercle d'un équipement",
};
