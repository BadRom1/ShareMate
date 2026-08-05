import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_SUB_EQUIPMENTS, SubEquipmentService } from './sub-equipment-service.js';
import { DomainError, ForbiddenError, NotFoundError } from '../domain/shared/domain-error.js';
import { makeFixture } from './testing/fixture.js';
import { InMemorySubEquipmentRepository } from './testing/in-memory.js';

async function setup() {
  const fx = await makeFixture();
  const subEquipments = new InMemorySubEquipmentRepository();
  const service = new SubEquipmentService(subEquipments, fx.equipments, fx.idGenerator);
  return { service, subEquipments };
}

describe('SubEquipmentService', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('ajoute au lot et le restitue dans l’ordre de saisie', async () => {
    await ctx.service.add({ equipmentId: 'e1', requesterId: 'm1', name: 'Remorque' });
    await ctx.service.add({
      equipmentId: 'e1',
      requesterId: 'm2',
      name: 'Godets',
      quantity: 3,
      notes: '30, 60, 90 cm',
    });
    await ctx.service.add({ equipmentId: 'e1', requesterId: 'm1', name: 'Jerrican' });

    const lot = await ctx.service.list('e1', 'm1');
    expect(lot.map((s) => s.name)).toEqual(['Remorque', 'Godets', 'Jerrican']);
    expect(lot.map((s) => s.position)).toEqual([0, 1, 2]);
    expect(lot[1]!.quantity).toBe(3);
    expect(lot[1]!.notes).toBe('30, 60, 90 cm');
  });

  it('compte un exemplaire quand la quantité n’est pas précisée', async () => {
    const ajouté = await ctx.service.add({ equipmentId: 'e1', requesterId: 'm1', name: 'Pompe à graisse' });
    expect(ajouté.quantity).toBe(1);
    expect(ajouté.notes).toBeNull();
  });

  it('range le suivant après le dernier, même après une suppression', async () => {
    // Réutiliser la position d'un élément retiré ferait remonter le nouveau au milieu du lot.
    const premier = await ctx.service.add({ equipmentId: 'e1', requesterId: 'm1', name: 'Remorque' });
    const second = await ctx.service.add({ equipmentId: 'e1', requesterId: 'm1', name: 'Godets' });
    await ctx.service.remove(second.id, 'm1');
    const troisième = await ctx.service.add({ equipmentId: 'e1', requesterId: 'm1', name: 'Jerrican' });
    expect(troisième.position).toBeGreaterThan(premier.position);
    expect((await ctx.service.list('e1', 'm1')).map((s) => s.name)).toEqual(['Remorque', 'Jerrican']);
  });

  it('le lot appartient au cercle : chaque membre le complète, le corrige et le retire', async () => {
    const godets = await ctx.service.add({ equipmentId: 'e1', requesterId: 'm1', name: 'Godets', quantity: 2 });
    // Bruno (m2) n'a pas saisi cet élément : il le corrige quand même.
    const corrigé = await ctx.service.update(godets.id, 'm2', { quantity: 3, notes: 'plus le godet de curage' });
    expect(corrigé.quantity).toBe(3);
    expect(corrigé.notes).toBe('plus le godet de curage');
    expect(corrigé.name).toBe('Godets');

    await ctx.service.remove(godets.id, 'm2');
    expect(await ctx.service.list('e1', 'm1')).toHaveLength(0);
  });

  it('efface une précision remise à null', async () => {
    const s = await ctx.service.add({ equipmentId: 'e1', requesterId: 'm1', name: 'Godets', notes: 'à vérifier' });
    expect((await ctx.service.update(s.id, 'm1', { notes: null })).notes).toBeNull();
  });

  it('hors du cercle, le lot n’existe pas : ni en lecture, ni en écriture', async () => {
    const godets = await ctx.service.add({ equipmentId: 'e1', requesterId: 'm1', name: 'Godets' });
    // Chloé (m3) n'appartient pas au cercle de la minipelle.
    await expect(ctx.service.list('e1', 'm3')).rejects.toThrow(ForbiddenError);
    await expect(ctx.service.add({ equipmentId: 'e1', requesterId: 'm3', name: 'Godets' })).rejects.toThrow(
      ForbiddenError,
    );
    await expect(ctx.service.update(godets.id, 'm3', { name: 'X' })).rejects.toThrow(ForbiddenError);
    await expect(ctx.service.remove(godets.id, 'm3')).rejects.toThrow(ForbiddenError);
  });

  it('masque le refus derrière l’absence du sous-équipement, sans nommer l’équipement', async () => {
    // Nommer l'équipement dans le refus révélerait l'identifiant d'un cercle auquel on n'appartient
    // pas — exactement ce que le masquage des refus interdit ailleurs.
    const godets = await ctx.service.add({ equipmentId: 'e1', requesterId: 'm1', name: 'Godets' });
    await expect(ctx.service.remove(godets.id, 'm3')).rejects.toThrow(`Sous-équipement introuvable : ${godets.id}`);
  });

  it('signale un équipement ou un sous-équipement introuvable', async () => {
    await expect(ctx.service.list('nope', 'm1')).rejects.toThrow(NotFoundError);
    await expect(ctx.service.add({ equipmentId: 'nope', requesterId: 'm1', name: 'X' })).rejects.toThrow(NotFoundError);
    await expect(ctx.service.update('nope', 'm1', { name: 'X' })).rejects.toThrow(NotFoundError);
    await expect(ctx.service.remove('nope', 'm1')).rejects.toThrow(NotFoundError);
  });

  it('borne la taille du lot', async () => {
    for (let i = 0; i < MAX_SUB_EQUIPMENTS; i += 1) {
      await ctx.service.add({ equipmentId: 'e1', requesterId: 'm1', name: `Élément ${i}` });
    }
    await expect(ctx.service.add({ equipmentId: 'e1', requesterId: 'm1', name: 'De trop' })).rejects.toThrow(
      DomainError,
    );
  });

  it('un lot ne déborde pas sur un autre équipement', async () => {
    await ctx.service.add({ equipmentId: 'e1', requesterId: 'm1', name: 'Remorque' });
    expect(await ctx.service.list('e1', 'm1')).toHaveLength(1);
    // Le second équipement du fixture n'existe pas : la garde de cercle répond avant toute lecture.
    await expect(ctx.service.list('e2', 'm1')).rejects.toThrow(NotFoundError);
  });
});
