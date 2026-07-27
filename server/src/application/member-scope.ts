import { circleMemberIds } from './equipment-access.js';
import type { EquipmentRepository, MemberRepository } from './ports.js';

/**
 * Périmètre relationnel d'un membre : lui-même, les membres des cercles qu'il partage, et ceux que
 * l'invitation relie à lui — dans les deux sens, son invitant comme ses invités. C'est le seul lien
 * entre eux tant qu'aucun équipement ne les réunit, et il est mutuel par nature : l'un a donné à
 * l'autre son accès à l'instance. Sans le sens montant, un membre fraîchement invité n'aurait
 * personne à qui ouvrir son premier équipement, pas même celui qui l'a fait entrer.
 *
 * C'est la borne commune de ce qu'un membre voit (annuaire) et de ceux sur qui il peut agir
 * (composer un cercle, se voir signaler un doublon d'adresse). Hors de là, il n'a aucune raison
 * de savoir qu'un autre membre existe.
 *
 * Ce périmètre s'écrit en partie par celui qu'il borne — il suffit d'ouvrir un équipement à
 * quelqu'un de son périmètre pour l'élargir au sien : il cadre la visibilité, il ne porte aucun
 * geste irréversible. La régénération d'une invitation, elle, s'en tient à l'invitant.
 */
export async function visibleMemberIds(
  equipments: EquipmentRepository,
  members: MemberRepository,
  requesterId: string,
): Promise<Set<string>> {
  const ids = await circleMemberIds(equipments, requesterId);
  const requester = await members.findById(requesterId);
  if (requester?.invitedById) {
    ids.add(requester.invitedById);
  }
  for (const invited of await members.findInvitedBy(requesterId)) {
    ids.add(invited.id);
  }
  return ids;
}
