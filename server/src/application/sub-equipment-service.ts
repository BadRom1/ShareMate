import { SubEquipment } from '../domain/equipment/sub-equipment.js';
import { DomainError, NotFoundError } from '../domain/shared/domain-error.js';
import { equipmentForMember } from './equipment-access.js';
import type { EquipmentRepository, IdGenerator, SubEquipmentRepository } from './ports.js';

export interface AddSubEquipmentInput {
  equipmentId: string;
  requesterId: string;
  name: string;
  /** Absente = un exemplaire : la quantité est une précision, pas une saisie obligatoire. */
  quantity?: number;
  notes?: string | null;
}

export interface UpdateSubEquipmentInput {
  name?: string;
  quantity?: number;
  notes?: string | null;
}

/**
 * Le lot tient sur la fiche de l'équipement et se charge avec elle : le borner ici évite qu'un
 * cercle rende sa propre page illisible, et que la liste des équipements coûte un inventaire.
 */
export const MAX_SUB_EQUIPMENTS = 100;

/**
 * Sous-équipements d'un équipement : ce qui part avec lui (remorque, godets, pompe à graisse,
 * caisse à outils, jerrican…). C'est un inventaire du lot, pas un équipement en réduction — rien
 * ici ne se réserve, ne relève de compteur ni ne porte de dépense.
 *
 * Comme les checklists et les documents, un sous-équipement appartient au cercle et non à celui
 * qui l'a saisi : tout membre du cercle le complète, le corrige et le retire. Le cercle de
 * l'équipement est la frontière d'accès, en lecture comme en écriture.
 */
export class SubEquipmentService {
  constructor(
    private readonly subEquipments: SubEquipmentRepository,
    private readonly equipments: EquipmentRepository,
    private readonly idGenerator: IdGenerator,
  ) {}

  async list(equipmentId: string, requesterId: string): Promise<SubEquipment[]> {
    await equipmentForMember(this.equipments, equipmentId, requesterId);
    return this.subEquipments.findByEquipmentId(equipmentId);
  }

  async add(input: AddSubEquipmentInput): Promise<SubEquipment> {
    await equipmentForMember(this.equipments, input.equipmentId, input.requesterId);
    const existing = await this.subEquipments.findByEquipmentId(input.equipmentId);
    if (existing.length >= MAX_SUB_EQUIPMENTS) {
      throw new DomainError(`Le lot de cet équipement est plein (${MAX_SUB_EQUIPMENTS} éléments au maximum).`);
    }
    const subEquipment = SubEquipment.create({
      id: this.idGenerator.next(),
      equipmentId: input.equipmentId,
      name: input.name,
      quantity: input.quantity ?? 1,
      notes: input.notes ?? null,
      position: nextPosition(existing),
    });
    await this.subEquipments.save(subEquipment);
    return subEquipment;
  }

  async update(id: string, requesterId: string, changes: UpdateSubEquipmentInput): Promise<SubEquipment> {
    const existing = await this.forMember(id, requesterId);
    const updated = existing.update(changes);
    await this.subEquipments.save(updated);
    return updated;
  }

  async remove(id: string, requesterId: string): Promise<void> {
    await this.forMember(id, requesterId);
    await this.subEquipments.delete(id);
  }

  /**
   * Sous-équipement demandé, une fois le demandeur reconnu dans le cercle de son équipement.
   * Le refus porte le message de l'absence du sous-équipement, et non de l'équipement qui le
   * porte : sinon la réponse révélerait l'identifiant d'un équipement d'un autre cercle.
   */
  private async forMember(id: string, requesterId: string): Promise<SubEquipment> {
    const absent = `Sous-équipement introuvable : ${id}`;
    const subEquipment = await this.subEquipments.findById(id);
    if (!subEquipment) throw new NotFoundError(absent);
    await equipmentForMember(this.equipments, subEquipment.equipmentId, requesterId, absent);
    return subEquipment;
  }
}

/** Rang du prochain élément ajouté : après le dernier, même si des positions ont été libérées. */
function nextPosition(list: SubEquipment[]): number {
  return list.reduce((max, item) => Math.max(max, item.position + 1), 0);
}
