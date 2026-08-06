import { describe, expect, it } from 'vitest';
import { DomainError } from '../shared/domain-error.js';
import { MAX_QUANTITY, SubEquipment } from './sub-equipment.js';

const base = {
  id: 's1',
  equipmentId: 'e1',
  name: 'Godet 30 cm',
  quantity: 1,
  notes: null,
  position: 0,
};

describe('SubEquipment', () => {
  it('se crée avec son nom, sa quantité et sa précision', () => {
    const s = SubEquipment.create({ ...base, quantity: 3, notes: 'Rangés dans la remorque' });
    expect(s.name).toBe('Godet 30 cm');
    expect(s.quantity).toBe(3);
    expect(s.notes).toBe('Rangés dans la remorque');
    expect(s.equipmentId).toBe('e1');
  });

  it('rejette un nom vide', () => {
    expect(() => SubEquipment.create({ ...base, name: '   ' })).toThrow(DomainError);
  });

  it('rogne les espaces de bord du nom', () => {
    expect(SubEquipment.create({ ...base, name: '  Remorque  ' }).name).toBe('Remorque');
  });

  it('rejette un nom trop long', () => {
    expect(() => SubEquipment.create({ ...base, name: 'x'.repeat(121) })).toThrow(DomainError);
  });

  it('exige une quantité entière et strictement positive', () => {
    expect(() => SubEquipment.create({ ...base, quantity: 0 })).toThrow(DomainError);
    expect(() => SubEquipment.create({ ...base, quantity: -1 })).toThrow(DomainError);
    expect(() => SubEquipment.create({ ...base, quantity: 1.5 })).toThrow(DomainError);
  });

  it('borne la quantité', () => {
    expect(SubEquipment.create({ ...base, quantity: MAX_QUANTITY }).quantity).toBe(MAX_QUANTITY);
    expect(() => SubEquipment.create({ ...base, quantity: MAX_QUANTITY + 1 })).toThrow(DomainError);
  });

  it('lit une précision vide comme une absence de précision', () => {
    // Le formulaire envoie toujours le champ, vide compris : sans cette lecture, la fiche
    // afficherait une ligne de précision blanche sous la moitié des éléments du lot.
    expect(SubEquipment.create({ ...base, notes: '   ' }).notes).toBeNull();
    expect(SubEquipment.create({ ...base, notes: undefined }).notes).toBeNull();
  });

  it('rejette une précision trop longue', () => {
    expect(() => SubEquipment.create({ ...base, notes: 'x'.repeat(501) })).toThrow(DomainError);
  });

  it('rejette une position négative ou fractionnaire', () => {
    expect(() => SubEquipment.create({ ...base, position: -1 })).toThrow(DomainError);
    expect(() => SubEquipment.create({ ...base, position: 0.5 })).toThrow(DomainError);
  });

  describe('update', () => {
    it('ne modifie que les champs fournis', () => {
      const s = SubEquipment.create({ ...base, quantity: 2, notes: 'Dans la remorque', position: 3 });
      const modifié = s.update({ name: 'Godet 60 cm' });
      expect(modifié.name).toBe('Godet 60 cm');
      expect(modifié.quantity).toBe(2);
      expect(modifié.notes).toBe('Dans la remorque');
      // Le rang et le rattachement ne se modifient pas : ils ne sont pas dans le formulaire.
      expect(modifié.position).toBe(3);
      expect(modifié.equipmentId).toBe('e1');
    });

    it('efface la précision quand elle est remise à null', () => {
      // `null` est un geste (« je retire cette précision »), à distinguer de « je ne touche à rien ».
      const s = SubEquipment.create({ ...base, notes: 'Dans la remorque' });
      expect(s.update({ notes: null }).notes).toBeNull();
      expect(s.update({}).notes).toBe('Dans la remorque');
    });

    it('valide la modification comme une création', () => {
      const s = SubEquipment.create(base);
      expect(() => s.update({ name: '' })).toThrow(DomainError);
      expect(() => s.update({ quantity: 0 })).toThrow(DomainError);
    });
  });
});
