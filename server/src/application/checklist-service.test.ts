import { beforeEach, describe, expect, it } from 'vitest';
import { ChecklistService } from './checklist-service.js';
import { DomainError, NotFoundError } from '../domain/shared/domain-error.js';
import { makeFixture } from './testing/fixture.js';
import { InMemoryChecklistItemRepository, InMemoryChecklistRepository } from './testing/in-memory.js';

async function setup() {
  const fx = await makeFixture();
  const checklists = new InMemoryChecklistRepository();
  const items = new InMemoryChecklistItemRepository();
  const service = new ChecklistService(checklists, items, fx.equipments, fx.idGenerator, fx.clock);
  return { service, checklists, items, clock: fx.clock };
}

describe('ChecklistService', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('crée une checklist avec ses points et la liste avec son avancement', async () => {
    await ctx.service.createChecklist({
      equipmentId: 'e1',
      authorId: 'm1',
      title: 'Avant utilisation',
      itemLabels: ['Niveau d’huile', '  ', 'Pression des chenilles'],
    });
    const list = await ctx.service.listChecklists('e1', 'm1');
    expect(list).toHaveLength(1);
    expect(list[0]!.checklist.title).toBe('Avant utilisation');
    // Le libellé vide de la saisie multiligne est ignoré.
    expect(list[0]!.itemCount).toBe(2);
    expect(list[0]!.checkedCount).toBe(0);
    expect((await ctx.service.listItems(list[0]!.checklist.id, 'm1')).map((i) => i.position)).toEqual([0, 1]);
  });

  it('plusieurs checklists cohabitent sur un même équipement', async () => {
    await ctx.service.createChecklist({ equipmentId: 'e1', authorId: 'm1', title: 'Avant utilisation' });
    await ctx.service.createChecklist({ equipmentId: 'e1', authorId: 'm2', title: 'Hivernage' });
    expect(await ctx.service.listChecklists('e1', 'm1')).toHaveLength(2);
  });

  it("refuse un membre hors du cercle de l'équipement", async () => {
    await expect(ctx.service.createChecklist({ equipmentId: 'e1', authorId: 'm3', title: 'X' })).rejects.toThrow(
      DomainError,
    );
  });

  it('signale un équipement ou une checklist introuvable', async () => {
    await expect(ctx.service.createChecklist({ equipmentId: 'nope', authorId: 'm1', title: 'X' })).rejects.toThrow(
      NotFoundError,
    );
    await expect(ctx.service.addItem({ checklistId: 'nope', requesterId: 'm1', label: 'X' })).rejects.toThrow(
      NotFoundError,
    );
    await expect(ctx.service.setItemChecked('nope', 'm1', true)).rejects.toThrow(NotFoundError);
  });

  it('hors du cercle, aucune lecture : ni les checklists, ni leurs points', async () => {
    const checklist = await ctx.service.createChecklist({
      equipmentId: 'e1',
      authorId: 'm1',
      title: 'Avant utilisation',
      itemLabels: ['Niveau d’huile'],
    });
    // Chloé (m3) n'appartient pas au cercle de la minipelle.
    await expect(ctx.service.listChecklists('e1', 'm3')).rejects.toThrow(DomainError);
    await expect(ctx.service.listItems(checklist.id, 'm3')).rejects.toThrow(DomainError);
    // Les membres du cercle, eux, lisent normalement.
    expect(await ctx.service.listChecklists('e1', 'm2')).toHaveLength(1);
    expect(await ctx.service.listItems(checklist.id, 'm2')).toHaveLength(1);
  });

  it('ajoute un point à la suite (tout le cercle) et met à jour l’activité', async () => {
    const checklist = await ctx.service.createChecklist({
      equipmentId: 'e1',
      authorId: 'm1',
      title: 'Avant utilisation',
      itemLabels: ['Niveau d’huile'],
    });
    // Chloé, hors cercle, est refusée.
    await expect(
      ctx.service.addItem({ checklistId: checklist.id, requesterId: 'm3', label: 'Pirate' }),
    ).rejects.toThrow(DomainError);

    ctx.clock.set(new Date('2026-07-03T10:00:00Z'));
    // Bruno n'a pas créé la checklist mais fait partie du cercle : il peut l'étoffer.
    const added = await ctx.service.addItem({ checklistId: checklist.id, requesterId: 'm2', label: 'Gasoil' });
    expect(added.position).toBe(1);
    const [summary] = await ctx.service.listChecklists('e1', 'm1');
    expect(summary!.checklist.updatedAt).toEqual(new Date('2026-07-03T10:00:00Z'));
  });

  it('coche puis décoche un point : ouvert à tout le cercle, la coche est attribuée', async () => {
    const checklist = await ctx.service.createChecklist({
      equipmentId: 'e1',
      authorId: 'm1',
      title: 'Avant utilisation',
      itemLabels: ['Niveau d’huile'],
    });
    const [item] = await ctx.service.listItems(checklist.id, 'm1');

    // Bruno n'est pas l'auteur mais fait partie du cercle : il peut cocher.
    const checked = await ctx.service.setItemChecked(item!.id, 'm2', true);
    expect(checked.isChecked).toBe(true);
    expect(checked.checkedById).toBe('m2');
    expect((await ctx.service.listChecklists('e1', 'm1'))[0]!.checkedCount).toBe(1);

    // Chloé est hors du cercle : refusée.
    await expect(ctx.service.setItemChecked(item!.id, 'm3', true)).rejects.toThrow(DomainError);

    const unchecked = await ctx.service.setItemChecked(item!.id, 'm1', false);
    expect(unchecked.isChecked).toBe(false);
    expect(unchecked.checkedById).toBeNull();
  });

  it('remet la checklist à zéro (tout décoché) pour un membre du cercle', async () => {
    const checklist = await ctx.service.createChecklist({
      equipmentId: 'e1',
      authorId: 'm1',
      title: 'Avant utilisation',
      itemLabels: ['A', 'B'],
    });
    for (const item of await ctx.service.listItems(checklist.id, 'm1')) {
      await ctx.service.setItemChecked(item.id, 'm1', true);
    }
    expect((await ctx.service.listChecklists('e1', 'm1'))[0]!.checkedCount).toBe(2);

    await expect(ctx.service.resetChecklist(checklist.id, 'm3')).rejects.toThrow(DomainError);
    await ctx.service.resetChecklist(checklist.id, 'm2');
    expect((await ctx.service.listChecklists('e1', 'm1'))[0]!.checkedCount).toBe(0);
  });

  it('renomme la checklist et ses points depuis n’importe quel membre du cercle', async () => {
    const checklist = await ctx.service.createChecklist({
      equipmentId: 'e1',
      authorId: 'm1',
      title: 'Avant utilisation',
      itemLabels: ['Niveau d’huile'],
    });
    const [item] = await ctx.service.listItems(checklist.id, 'm1');

    // Chloé est hors cercle : refusée sur les deux gestes.
    await expect(ctx.service.renameChecklist(checklist.id, 'm3', 'Pirate')).rejects.toThrow(DomainError);
    await expect(ctx.service.renameItem(item!.id, 'm3', 'Pirate')).rejects.toThrow(DomainError);

    // Bruno n'est pas le créateur mais appartient au cercle.
    expect((await ctx.service.renameChecklist(checklist.id, 'm2', 'Avant chantier')).title).toBe('Avant chantier');
    expect((await ctx.service.renameItem(item!.id, 'm2', 'Huile moteur')).label).toBe('Huile moteur');
  });

  it('supprime un point, puis la checklist et ses points depuis tout le cercle', async () => {
    const checklist = await ctx.service.createChecklist({
      equipmentId: 'e1',
      authorId: 'm1',
      title: 'Avant utilisation',
      itemLabels: ['A', 'B'],
    });
    const items = await ctx.service.listItems(checklist.id, 'm1');

    // Hors cercle : refusé. Dans le cercle sans être le créateur : autorisé.
    await expect(ctx.service.deleteItem(items[0]!.id, 'm3')).rejects.toThrow(DomainError);
    await ctx.service.deleteItem(items[0]!.id, 'm2');
    expect(await ctx.service.listItems(checklist.id, 'm1')).toHaveLength(1);

    // Le point ajouté ensuite se place après le dernier restant, sans réutiliser la position libérée.
    const added = await ctx.service.addItem({ checklistId: checklist.id, requesterId: 'm1', label: 'C' });
    expect(added.position).toBe(2);

    await expect(ctx.service.deleteChecklist(checklist.id, 'm3')).rejects.toThrow(DomainError);
    await ctx.service.deleteChecklist(checklist.id, 'm2');
    expect(await ctx.service.listChecklists('e1', 'm1')).toHaveLength(0);
    // La checklist n'existe plus : on constate la cascade directement sur le dépôt.
    expect(await ctx.items.findByChecklistId(checklist.id)).toHaveLength(0);
  });
});
