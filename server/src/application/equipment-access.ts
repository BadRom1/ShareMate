import { ForbiddenError, NotFoundError } from '../domain/shared/domain-error.js';
import type { Equipment } from '../domain/equipment/equipment.js';
import type { EquipmentRepository } from './ports.js';

/**
 * Règle d'accès unique de l'application : tout ce qui pend à un équipement
 * (réservations, usage, dépenses, discussions, checklists) n'est visible et
 * modifiable que par les membres de son cercle. Un membre authentifié qui n'en
 * fait pas partie est traité comme un étranger, en lecture comme en écriture.
 *
 * Le refus est **masqué** : il porte le message qu'aurait produit une ressource
 * inexistante, et l'adapter HTTP le rend en 404. Une réponse ne permet donc pas de
 * distinguer « cette ressource n'existe pas » de « elle existe mais pas pour vous »,
 * ce qui interdit d'énumérer les identifiants des autres cercles.
 */

/** Message d'absence d'un équipement, réutilisé tel quel pour masquer un refus. */
export function equipmentNotFound(equipmentId: string): string {
  return `Équipement introuvable : ${equipmentId}`;
}

/**
 * Équipement demandé, à condition que le membre en partage le cercle.
 *
 * `notFoundMessage` masque le refus derrière l'absence de la ressource par laquelle
 * on est arrivé : en interrogeant une réservation d'un autre cercle, la réponse doit
 * annoncer « Réservation introuvable », pas l'équipement qui la porte.
 */
export async function equipmentForMember(
  equipments: EquipmentRepository,
  equipmentId: string,
  memberId: string,
  notFoundMessage: string = equipmentNotFound(equipmentId),
): Promise<Equipment> {
  const equipment = await equipments.findById(equipmentId);
  if (!equipment) throw new NotFoundError(notFoundMessage);
  if (!equipment.canBeUsedBy(memberId)) throw new ForbiddenError(notFoundMessage);
  return equipment;
}

/**
 * Équipements dont le membre partage le cercle. Sert à cadrer les vues globales
 * (calendrier, alertes d'entretien, liste des équipements) sur son périmètre.
 *
 * Le cadrage est délégué au port : c'est la persistance qui sait le faire sans relire tout
 * l'inventaire de l'instance. La couche application garde la règle, pas le balayage.
 */
export async function equipmentsForMember(equipments: EquipmentRepository, memberId: string): Promise<Equipment[]> {
  return equipments.findByMemberId(memberId);
}

/**
 * Membres avec lesquels `memberId` partage au moins un cercle, lui-même compris. Étend la règle
 * d'accès aux gestes qui visent une personne et non un équipement (annuaire, invitation) : hors de
 * cet ensemble, un membre n'a aucune raison de savoir qu'un autre existe.
 */
export async function circleMemberIds(equipments: EquipmentRepository, memberId: string): Promise<Set<string>> {
  const ids = new Set<string>([memberId]);
  for (const equipment of await equipmentsForMember(equipments, memberId)) {
    for (const id of equipment.memberIds) ids.add(id);
  }
  return ids;
}

/** Identifiants des équipements accessibles, pour filtrer une liste hétérogène. */
export async function accessibleEquipmentIds(equipments: EquipmentRepository, memberId: string): Promise<Set<string>> {
  return new Set((await equipmentsForMember(equipments, memberId)).map((e) => e.id));
}
