import type { Document } from '../domain/document/document.js';
import type { DocumentRepository, ObjectStorage } from './ports.js';

/**
 * Un document n'est pas une ressource autonome : il n'existe que par l'équipement auquel il est
 * rattaché, et suit donc exactement la règle d'accès de celui-ci (le cercle de ses membres).
 * L'objet stocké, lui, n'est jamais joignable directement — sa clé ne sort du serveur que le
 * temps d'une URL signée, et sa lecture repasse par le document qui le nomme.
 */

/** Message d'absence d'un document, réutilisé tel quel pour masquer un refus. */
export function documentNotFound(id: string): string {
  return `Document introuvable : ${id}`;
}

/**
 * Supprime les objets des documents effacés que plus aucun document ne nomme. Sans cela le bucket
 * ne fait que croître : rien d'autre ne rattrape ces fichiers, dont plus personne ne connaît la clé.
 *
 * Les documents effacés sont écartés du décompte plutôt que relus : la suppression d'un équipement
 * emporte les siens par cascade de la persistance, et l'application n'a pas à savoir si celle-ci a
 * déjà eu lieu. Sans stockage configuré, il n'y a rien à purger.
 */
export async function purgeOrphanObjects(
  documents: DocumentRepository,
  storage: ObjectStorage | undefined,
  deleted: readonly Document[],
): Promise<void> {
  if (!storage) return;
  const deletedIds = new Set(deleted.map((d) => d.id));
  const storageKeys = new Set(deleted.map((d) => d.storageKey).filter((key): key is string => key !== null));
  for (const storageKey of storageKeys) {
    const carriers = (await documents.findByStorageKey(storageKey)).filter((d) => !deletedIds.has(d.id));
    if (carriers.length === 0) {
      await storage.delete(storageKey);
    }
  }
}
