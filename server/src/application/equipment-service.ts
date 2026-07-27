import { Equipment } from '../domain/equipment/equipment.js';
import type { MeterUnit } from '../domain/equipment/equipment.js';
import { Money } from '../domain/shared/money.js';
import { DomainError } from '../domain/shared/domain-error.js';
import { equipmentForMember, equipmentsForMember } from './equipment-access.js';
import { visibleMemberIds } from './member-scope.js';
import { purgeOrphanReceipts } from './receipt-access.js';
import type {
  AuditLogger,
  EquipmentRepository,
  ExpenseRepository,
  IdGenerator,
  MemberRepository,
  Notifier,
  ReceiptStorage,
} from './ports.js';

export interface CreateEquipmentInput {
  name: string;
  category: string;
  acquisitionDate: string;
  purchaseValueEuros: number;
  meterUnit: MeterUnit;
  memberIds: string[];
  maintenanceThreshold: number | null;
}

export interface UpdateEquipmentInput {
  name?: string;
  category?: string;
  acquisitionDate?: string;
  purchaseValueEuros?: number;
  meterUnit?: MeterUnit;
  memberIds?: string[];
  maintenanceThreshold?: number | null;
}

/** Résumé du changement de composition, pour le corps de la notification aux membres restants. */
function describeChange(removed: number, added: number): string {
  const parts: string[] = [];
  if (removed > 0) parts.push(`${removed} membre${removed > 1 ? 's' : ''} retiré${removed > 1 ? 's' : ''}`);
  if (added > 0) parts.push(`${added} membre${added > 1 ? 's' : ''} ajouté${added > 1 ? 's' : ''}`);
  return parts.join(', ');
}

export class EquipmentService {
  constructor(
    private readonly equipments: EquipmentRepository,
    private readonly members: MemberRepository,
    private readonly idGenerator: IdGenerator,
    // Supprimer un équipement emporte ses dépenses (cascade de la persistance) : leurs
    // justificatifs, eux, sont des fichiers, hors de portée de cette cascade.
    private readonly expenses: ExpenseRepository,
    private readonly notifier: Notifier,
    private readonly audit: AuditLogger,
    private readonly receipts?: ReceiptStorage,
  ) {}

  /**
   * Membres qu'un demandeur peut inscrire dans un cercle : ceux de son périmètre relationnel,
   * et eux seuls. Sans cette garde, `memberIds` est un champ libre — n'importe quel identifiant
   * connu entre dans le cercle de son choix, sans que l'intéressé le sache ni y consente. Le
   * périmètre devient alors inscriptible par celui qu'il est censé borner, ce qui le rend
   * inutilisable comme règle d'accès partout où il sert (annuaire, invitations).
   *
   * Un identifiant hors périmètre reçoit le message d'un identifiant inconnu : appartenir au
   * périmètre implique d'exister, et distinguer les deux refus permettrait d'énumérer les membres.
   */
  private async assertMembersAssignable(memberIds: string[], requesterId: string): Promise<void> {
    const scope = await visibleMemberIds(this.equipments, this.members, requesterId);
    const rejected = memberIds.filter((memberId) => !scope.has(memberId));
    if (rejected.length > 0) {
      throw new DomainError(`Membres inconnus : ${rejected.join(', ')}`);
    }
  }

  async create(input: CreateEquipmentInput, creatorId: string): Promise<Equipment> {
    await this.assertMembersAssignable(input.memberIds, creatorId);
    // Sans son créateur dans le cercle, l'équipement serait invisible pour lui dès sa création.
    if (!input.memberIds.includes(creatorId)) {
      throw new DomainError("Vous devez faire partie du cercle de l'équipement que vous créez.");
    }
    const equipment = Equipment.create({
      id: this.idGenerator.next(),
      name: input.name,
      category: input.category,
      acquisitionDate: new Date(input.acquisitionDate),
      purchaseValue: Money.fromEuros(input.purchaseValueEuros),
      meterUnit: input.meterUnit,
      memberIds: input.memberIds,
      maintenanceThreshold: input.maintenanceThreshold,
    });
    await this.equipments.save(equipment);
    return equipment;
  }

  async update(id: string, input: UpdateEquipmentInput, requesterId: string): Promise<Equipment> {
    // Le cercle se coopte : seul un membre peut modifier l'équipement, y compris sa composition.
    const existing = await equipmentForMember(this.equipments, id, requesterId);
    if (input.memberIds) {
      await this.assertMembersAssignable(input.memberIds, requesterId);
      // Décocher sa propre case ferait disparaître l'équipement et tout son historique de la vue
      // de l'auteur, sans retour possible — trop lourd pour un effet de bord d'un formulaire.
      // Partir est un geste à part entière : `leaveCircle`.
      if (!input.memberIds.includes(requesterId)) {
        throw new DomainError(
          'Vous ne pouvez pas vous retirer du cercle en modifiant l’équipement : utilisez « quitter le cercle ».',
        );
      }
    }
    const updated = existing.update({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.category !== undefined && { category: input.category }),
      ...(input.acquisitionDate !== undefined && { acquisitionDate: new Date(input.acquisitionDate) }),
      ...(input.purchaseValueEuros !== undefined && { purchaseValue: Money.fromEuros(input.purchaseValueEuros) }),
      ...(input.meterUnit !== undefined && { meterUnit: input.meterUnit }),
      ...(input.memberIds !== undefined && { memberIds: input.memberIds }),
      ...(input.maintenanceThreshold !== undefined && { maintenanceThreshold: input.maintenanceThreshold }),
    });
    await this.equipments.save(updated);
    await this.announceCircleChange(existing, updated, requesterId);
    return updated;
  }

  /**
   * Quitte le cercle d'un équipement. Geste dédié, distinct de `update` : il est irréversible
   * (seul un membre restant peut réinviter le partant) et il prévient ceux qui restent.
   */
  async leaveCircle(id: string, requesterId: string): Promise<void> {
    const existing = await equipmentForMember(this.equipments, id, requesterId);
    const remaining = existing.memberIds.filter((memberId) => memberId !== requesterId);
    // Un cercle vide est impossible (Equipment.create) et l'équipement deviendrait invisible
    // pour tous, donc irrécupérable : le dernier membre supprime, il ne quitte pas.
    if (remaining.length === 0) {
      throw new DomainError(
        'Vous êtes le dernier membre de ce cercle : supprimez l’équipement plutôt que de le quitter.',
      );
    }
    const updated = existing.update({ memberIds: remaining });
    await this.equipments.save(updated);
    this.audit.record({
      action: 'equipement.cercle-quitte',
      actorId: requesterId,
      targetId: id,
      details: { restants: remaining },
    });
    await this.notifier.notify({
      type: 'EQUIPMENT_CIRCLE_CHANGED',
      recipientIds: remaining,
      title: `👥 ${existing.name}`,
      body: `${await this.memberName(requesterId)} a quitté le cercle de « ${existing.name} ».`,
      link: '/?tab=equipments',
    });
  }

  private async memberName(memberId: string): Promise<string> {
    return (await this.members.findById(memberId))?.name ?? 'Un membre';
  }

  /**
   * Journalise et notifie tout changement de composition. Sans cela, un membre peut évincer
   * tout le cercle d'un bien partagé — et de son historique de dépenses et de soldes — sans que
   * quiconque en soit informé ni qu'il en reste trace.
   */
  private async announceCircleChange(before: Equipment, after: Equipment, actorId: string): Promise<void> {
    const removed = before.memberIds.filter((memberId) => !after.canBeUsedBy(memberId));
    const added = after.memberIds.filter((memberId) => !before.canBeUsedBy(memberId));
    if (removed.length === 0 && added.length === 0) {
      return;
    }
    this.audit.record({
      action: 'equipement.cercle-modifie',
      actorId,
      targetId: after.id,
      details: { retires: removed, ajoutes: added, cercle: [...after.memberIds] },
    });
    const author = await this.memberName(actorId);
    if (removed.length > 0) {
      await this.notifier.notify({
        type: 'EQUIPMENT_CIRCLE_CHANGED',
        recipientIds: removed,
        title: `👥 ${after.name}`,
        body: `${author} vous a retiré du cercle de « ${after.name} » : cet équipement et son historique ne vous sont plus accessibles.`,
        link: null,
      });
    }
    if (added.length > 0) {
      await this.notifier.notify({
        type: 'EQUIPMENT_CIRCLE_CHANGED',
        recipientIds: added,
        title: `👥 ${after.name}`,
        body: `${author} vous a ajouté au cercle de « ${after.name} ».`,
        link: '/?tab=equipments',
      });
    }
    // Les membres qui restent sont prévenus aussi : une éviction ne doit pas se découvrir
    // par l'absence d'un nom dans une liste.
    const witnesses = after.memberIds.filter((memberId) => memberId !== actorId && !added.includes(memberId));
    if (witnesses.length > 0) {
      await this.notifier.notify({
        type: 'EQUIPMENT_CIRCLE_CHANGED',
        recipientIds: witnesses,
        title: `👥 ${after.name}`,
        body: `${author} a modifié le cercle de « ${after.name} » (${describeChange(removed.length, added.length)}).`,
        link: '/?tab=equipments',
      });
    }
  }

  async delete(id: string, requesterId: string): Promise<void> {
    await equipmentForMember(this.equipments, id, requesterId);
    // Relevées avant : la cascade les efface avec l'équipement, et plus rien ne nommera leurs fichiers.
    const doomed = await this.expenses.findByEquipmentId(id);
    await this.equipments.delete(id);
    await purgeOrphanReceipts(this.expenses, this.receipts, doomed);
  }

  async getById(id: string, requesterId: string): Promise<Equipment> {
    return equipmentForMember(this.equipments, id, requesterId);
  }

  /** Équipements du cercle du demandeur : les autres n'existent pas pour lui. */
  async list(requesterId: string): Promise<Equipment[]> {
    return equipmentsForMember(this.equipments, requesterId);
  }
}
