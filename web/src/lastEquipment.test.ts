import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLastEquipmentId, pickInitialEquipmentId, setLastEquipmentId } from './lastEquipment';

/**
 * `e1` appartient au cercle de `m2` seul : il n'est là que pour vérifier qu'on ne présélectionne
 * pas le premier de la liste tant qu'un équipement du membre reste disponible.
 */
const parc = [
  { id: 'e1', memberIds: ['m2'] },
  { id: 'e2', memberIds: ['m1'] },
  { id: 'e3', memberIds: ['m1', 'm2'] },
];

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mémoire du dernier équipement', () => {
  it('relit ce qui a été mémorisé', () => {
    setLastEquipmentId('e3');

    expect(getLastEquipmentId()).toBe('e3');
  });

  it('rend null quand rien n’a encore été mémorisé', () => {
    expect(getLastEquipmentId()).toBeNull();
  });
});

describe('pickInitialEquipmentId', () => {
  it('garde l’équipement déjà sélectionné, avant tout autre repère', () => {
    setLastEquipmentId('e2');

    expect(pickInitialEquipmentId(parc, 'm1', { current: 'e3', deepLink: 'e1' })).toBe('e3');
  });

  it('suit le deep-link plutôt que le dernier consulté', () => {
    setLastEquipmentId('e2');

    expect(pickInitialEquipmentId(parc, 'm1', { deepLink: 'e3' })).toBe('e3');
  });

  it('retombe sur le dernier consulté quand le deep-link désigne un équipement qui n’est plus partagé', () => {
    setLastEquipmentId('e3');

    // Membre retiré du cercle de `e9` entre deux visites : l'écran reste utilisable.
    expect(pickInitialEquipmentId(parc, 'm1', { deepLink: 'e9' })).toBe('e3');
  });

  it('ignore l’équipement déjà sélectionné s’il a disparu de la liste', () => {
    expect(pickInitialEquipmentId(parc, 'm1', { current: 'e9' })).toBe('e2');
  });

  it('ignore l’id mémorisé qui n’existe plus et prend un équipement du cercle du membre', () => {
    setLastEquipmentId('e9');

    expect(pickInitialEquipmentId(parc, 'm1', {})).toBe('e2');
  });

  it('préfère un équipement du cercle du membre au premier de la liste', () => {
    expect(pickInitialEquipmentId(parc, 'm1', {})).toBe('e2');
  });

  it('prend le premier de la liste quand le membre n’appartient au cercle d’aucun', () => {
    expect(pickInitialEquipmentId(parc, 'm3', {})).toBe('e1');
  });

  it('rend une chaîne vide sur une liste vide, même avec un deep-link', () => {
    expect(pickInitialEquipmentId([], 'm1', { deepLink: 'e1' })).toBe('');
  });

  it('choisit quand même un équipement si le stockage est indisponible', () => {
    // Mode privé de certains navigateurs : `localStorage` existe mais lève à l'accès.
    const indisponible = () => {
      throw new DOMException('stockage indisponible', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(indisponible);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(indisponible);

    expect(() => setLastEquipmentId('e3')).not.toThrow();
    expect(getLastEquipmentId()).toBeNull();
    expect(pickInitialEquipmentId(parc, 'm1', {})).toBe('e2');
    expect(pickInitialEquipmentId(parc, 'm1', { deepLink: 'e3' })).toBe('e3');
  });
});
