import { Checklist } from '../domain/checklist/checklist.js';
import { ChecklistItem } from '../domain/checklist/checklist-item.js';
import { DomainError, NotFoundError } from '../domain/shared/domain-error.js';
import type { ChecklistItemRepository, ChecklistRepository, Clock, EquipmentRepository, IdGenerator } from './ports.js';

export interface CreateChecklistInput {
  equipmentId: string;
  authorId: string;
  title: string;
  /** Points de contrôle créés d'emblée (dans l'ordre). */
  itemLabels?: string[];
}

export interface AddItemInput {
  checklistId: string;
  requesterId: string;
  label: string;
}

/** Checklist + avancement, pour l'affichage de la liste. */
export interface ChecklistSummary {
  checklist: Checklist;
  itemCount: number;
  checkedCount: number;
}

/**
 * Checklists par équipement. Une checklist appartient au cercle, pas à son créateur :
 * tout membre du cercle peut la remplir, la renommer, en modifier la structure et la
 * supprimer. `authorId` ne garde que la trace de qui l'a créée, et chaque coche celle
 * du membre qui l'a validée.
 *
 * Le cercle de l'équipement est la frontière d'accès : hors du cercle, rien n'est
 * visible ni modifiable — la lecture est contrôlée comme l'écriture.
 */
export class ChecklistService {
  constructor(
    private readonly checklists: ChecklistRepository,
    private readonly items: ChecklistItemRepository,
    private readonly equipments: EquipmentRepository,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  // --- Checklists ---

  async createChecklist(input: CreateChecklistInput): Promise<Checklist> {
    await this.assertInCircle(input.equipmentId, input.authorId);
    const now = this.clock.now();
    const checklist = Checklist.create({
      id: this.idGenerator.next(),
      equipmentId: input.equipmentId,
      authorId: input.authorId,
      title: input.title,
      createdAt: now,
    });
    await this.checklists.save(checklist);

    // Les libellés vides sont ignorés : le formulaire envoie une saisie multiligne brute.
    const labels = (input.itemLabels ?? []).map((label) => label.trim()).filter((label) => label.length > 0);
    for (const [index, label] of labels.entries()) {
      await this.items.save(
        ChecklistItem.create({
          id: this.idGenerator.next(),
          checklistId: checklist.id,
          label,
          position: index,
        }),
      );
    }
    return checklist;
  }

  async listChecklists(equipmentId: string, requesterId: string): Promise<ChecklistSummary[]> {
    await this.assertInCircle(equipmentId, requesterId);
    const checklists = await this.checklists.findByEquipmentId(equipmentId);
    return Promise.all(
      checklists.map(async (checklist) => {
        const items = await this.items.findByChecklistId(checklist.id);
        return {
          checklist,
          itemCount: items.length,
          checkedCount: items.filter((item) => item.isChecked).length,
        };
      }),
    );
  }

  async renameChecklist(id: string, requesterId: string, title: string): Promise<Checklist> {
    const checklist = await this.getChecklistForMember(id, requesterId);
    const renamed = checklist.rename(title, this.clock.now());
    await this.checklists.save(renamed);
    return renamed;
  }

  async deleteChecklist(id: string, requesterId: string): Promise<void> {
    await this.getChecklistForMember(id, requesterId);
    // Supprime d'abord les points (le cascade SQL couvre aussi, mais on reste cohérent en in-memory).
    for (const item of await this.items.findByChecklistId(id)) {
      await this.items.delete(item.id);
    }
    await this.checklists.delete(id);
  }

  /** Décoche tous les points : remet la checklist à zéro pour une nouvelle utilisation. */
  async resetChecklist(id: string, requesterId: string): Promise<void> {
    const checklist = await this.getChecklistForMember(id, requesterId);
    for (const item of await this.items.findByChecklistId(id)) {
      if (item.isChecked) await this.items.save(item.uncheck());
    }
    await this.checklists.save(checklist.touch(this.clock.now()));
  }

  // --- Points de contrôle ---

  async listItems(checklistId: string, requesterId: string): Promise<ChecklistItem[]> {
    await this.getChecklistForMember(checklistId, requesterId);
    return this.items.findByChecklistId(checklistId);
  }

  async addItem(input: AddItemInput): Promise<ChecklistItem> {
    const checklist = await this.getChecklistForMember(input.checklistId, input.requesterId);
    const existing = await this.items.findByChecklistId(checklist.id);
    const item = ChecklistItem.create({
      id: this.idGenerator.next(),
      checklistId: checklist.id,
      label: input.label,
      position: nextPosition(existing),
    });
    await this.items.save(item);
    await this.checklists.save(checklist.touch(this.clock.now()));
    return item;
  }

  async renameItem(id: string, requesterId: string, label: string): Promise<ChecklistItem> {
    const { item, checklist } = await this.getItemForMember(id, requesterId);
    const renamed = item.relabel(label);
    await this.items.save(renamed);
    await this.checklists.save(checklist.touch(this.clock.now()));
    return renamed;
  }

  async deleteItem(id: string, requesterId: string): Promise<void> {
    const { item, checklist } = await this.getItemForMember(id, requesterId);
    await this.items.delete(item.id);
    await this.checklists.save(checklist.touch(this.clock.now()));
  }

  /** Coche ou décoche un point ; la coche est attribuée au membre qui l'a faite. */
  async setItemChecked(id: string, memberId: string, checked: boolean): Promise<ChecklistItem> {
    const { item, checklist } = await this.getItemForMember(id, memberId);
    const now = this.clock.now();
    const updated = checked ? item.check(memberId, now) : item.uncheck();
    await this.items.save(updated);
    await this.checklists.save(checklist.touch(now));
    return updated;
  }

  // --- Helpers ---

  private async getChecklist(id: string): Promise<Checklist> {
    const checklist = await this.checklists.findById(id);
    if (!checklist) throw new NotFoundError(`Checklist introuvable : ${id}`);
    return checklist;
  }

  /** Checklist demandée, une fois le demandeur reconnu dans le cercle de son équipement. */
  private async getChecklistForMember(id: string, memberId: string): Promise<Checklist> {
    const checklist = await this.getChecklist(id);
    await this.assertInCircle(checklist.equipmentId, memberId);
    return checklist;
  }

  /** Point demandé (et sa checklist), une fois le demandeur reconnu dans le cercle. */
  private async getItemForMember(id: string, memberId: string): Promise<{ item: ChecklistItem; checklist: Checklist }> {
    const item = await this.items.findById(id);
    if (!item) throw new NotFoundError(`Point de contrôle introuvable : ${id}`);
    return { item, checklist: await this.getChecklistForMember(item.checklistId, memberId) };
  }

  /** Tout accès — lecture comme écriture — exige d'appartenir au cercle de l'équipement. */
  private async assertInCircle(equipmentId: string, memberId: string): Promise<void> {
    const equipment = await this.equipments.findById(equipmentId);
    if (!equipment) throw new NotFoundError(`Équipement introuvable : ${equipmentId}`);
    if (!equipment.canBeUsedBy(memberId)) {
      throw new DomainError("Seuls les membres du cercle de l'équipement peuvent gérer ses checklists.");
    }
  }
}

/** Rang du prochain point ajouté : après le dernier, même si des positions ont été libérées. */
function nextPosition(items: ChecklistItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.position + 1), 0);
}
