import { DomainError } from '../domain/shared/domain-error.js';
import type { DocumentRepository, MessageRepository } from './ports.js';

/**
 * Place occupée par les fichiers d'un même équipement (500 Mo), **tous usages confondus** :
 * documents du dossier et pièces jointes des discussions partagent le bucket, donc le même
 * plafond. Deux budgets séparés en feraient deux fois plus, et compter les seuls documents
 * laisserait les messages remplir le bucket sans borne — c'est par eux qu'il coûterait le moins
 * cher de le faire.
 *
 * Un bucket se facture à l'octet et rien d'autre ne borne les dépôts : le plafond par IP et par
 * minute borne le débit, pas le volume.
 */
export const EQUIPMENT_STORAGE_QUOTA_BYTES = 500 * 1024 * 1024;

/** Octets déjà occupés par cet équipement. Les liens ne pèsent rien : ils ne sont pas stockés. */
export async function usedStorageBytes(
  documents: DocumentRepository,
  messages: MessageRepository,
  equipmentId: string,
): Promise<number> {
  const [dossier, discussions] = await Promise.all([
    documents.findByEquipmentId(equipmentId),
    messages.findByEquipmentId(equipmentId),
  ]);
  const total = (somme: number, fichier: { sizeBytes?: number }) => somme + (fichier.sizeBytes ?? 0);
  return dossier.reduce(total, 0) + discussions.reduce((somme, m) => somme + (m.attachment?.sizeBytes ?? 0), 0);
}

/**
 * Refuse un dépôt qui ferait déborder l'équipement. Appelé **avant** que l'octet n'atteigne le
 * stockage : refuser après coup laisserait dans le bucket un objet que plus rien ne nommerait,
 * c'est-à-dire hors de portée de la purge.
 *
 * Le contrôle n'est pas atomique : deux dépôts simultanés lisent la même occupation avant que l'un
 * des deux n'enregistre, et le plafond peut donc être dépassé d'un fichier (25 Mo au plus). C'est
 * un garde-fou de facture, pas une réservation — pour trois personnes qui partagent une minipelle,
 * verrouiller la table pour 25 Mo coûterait plus qu'il ne rapporte.
 */
export async function assertStorageAvailable(
  documents: DocumentRepository,
  messages: MessageRepository,
  equipmentId: string,
  sizeBytes: number,
): Promise<void> {
  const used = await usedStorageBytes(documents, messages, equipmentId);
  if (used + sizeBytes > EQUIPMENT_STORAGE_QUOTA_BYTES) {
    const remaining = Math.max(0, EQUIPMENT_STORAGE_QUOTA_BYTES - used);
    throw new DomainError(
      `Les fichiers de cet équipement occupent toute la place disponible ` +
        `(${megabytes(EQUIPMENT_STORAGE_QUOTA_BYTES)} Mo). Il reste ${megabytes(remaining)} Mo : ` +
        `supprimez des documents ou des pièces jointes avant d’en déposer d’autres.`,
    );
  }
}

/** Mégaoctets arrondis, pour un message lisible par un membre (jamais pour un calcul). */
function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}
