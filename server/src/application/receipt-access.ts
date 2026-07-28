import { NotFoundError } from '../domain/shared/domain-error.js';
import type { Expense } from '../domain/expense/expense.js';
import { equipmentForMember } from './equipment-access.js';
import type { EquipmentRepository, ExpenseRepository, ReceiptStorage } from './ports.js';

/**
 * Un justificatif n'est pas une ressource autonome : il n'existe que par la dépense qui le porte,
 * et suit donc exactement la règle d'accès de celle-ci (le cercle de son équipement). Son nom est
 * un UUID v4, ce qui rend l'énumération impraticable — mais l'obscurité n'est pas un contrôle
 * d'accès, et c'est ici qu'il est appliqué.
 */

/** Message d'absence d'un justificatif, réutilisé tel quel pour masquer un refus. */
export function receiptNotFound(receiptPath: string): string {
  return `Justificatif introuvable : ${receiptPath}`;
}

/**
 * Dépense portant ce justificatif, à condition que le membre partage le cercle de son équipement.
 *
 * Hors cercle, la réponse est celle d'un justificatif inexistant : détenir le chemin d'un fichier
 * ne doit rien apprendre de plus que ne pas le détenir.
 *
 * Toutes les dépenses qui le portent doivent être accessibles, pas seulement une : sinon un membre
 * s'ouvrirait le fichier d'un autre cercle en recopiant son chemin dans une dépense à lui.
 * `ExpenseService.addExpense` interdit déjà ce doublon, ce filtre couvre les données antérieures.
 */
export async function expenseForReceipt(
  expenses: ExpenseRepository,
  equipments: EquipmentRepository,
  receiptPath: string,
  memberId: string,
): Promise<Expense> {
  const absent = receiptNotFound(receiptPath);
  const carriers = await expenses.findByReceiptPath(receiptPath);
  const first = carriers[0];
  if (!first) throw new NotFoundError(absent);
  for (const expense of carriers) {
    await equipmentForMember(equipments, expense.equipmentId, memberId, absent);
  }
  return first;
}

/**
 * Supprime les justificatifs des dépenses effacées qu'aucune autre dépense ne porte. Sans cela le
 * volume ne fait que croître : rien d'autre ne rattrape ces fichiers, dont plus personne ne
 * connaît le nom.
 *
 * Les dépenses effacées sont écartées du décompte plutôt que relues : la suppression d'un
 * équipement emporte les siennes par cascade de la persistance, et l'application n'a pas à savoir
 * si celle-ci a déjà eu lieu. Sans stockage configuré (upload désactivé), il n'y a rien à purger.
 */
export async function purgeOrphanReceipts(
  expenses: ExpenseRepository,
  receipts: ReceiptStorage | undefined,
  deleted: readonly Expense[],
): Promise<void> {
  if (!receipts) return;
  const deletedIds = new Set(deleted.map((e) => e.id));
  const receiptPaths = new Set(deleted.map((e) => e.receiptPath).filter((p): p is string => p !== null));
  for (const receiptPath of receiptPaths) {
    const carriers = (await expenses.findByReceiptPath(receiptPath)).filter((e) => !deletedIds.has(e.id));
    if (carriers.length === 0) {
      await receipts.delete(receiptPath);
    }
  }
}
