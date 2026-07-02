import { describe, expect, it } from 'vitest';
import { Group } from './group.js';
import { Member } from './member.js';

describe('Member', () => {
  it('se crée avec un nom non vide', () => {
    const m = Member.create({ id: 'm1', name: 'Alice' });
    expect(m.name).toBe('Alice');
  });

  it('rejette un nom vide', () => {
    expect(() => Member.create({ id: 'm1', name: '  ' })).toThrow();
  });
});

describe('Group', () => {
  it('se crée avec au moins un membre', () => {
    const g = Group.create({ id: 'g1', name: 'Les voisins', memberIds: ['m1', 'm2'] });
    expect(g.memberIds).toEqual(['m1', 'm2']);
  });

  it('rejette un groupe sans membre', () => {
    expect(() => Group.create({ id: 'g1', name: 'Vide', memberIds: [] })).toThrow();
  });

  it('dédoublonne les membres', () => {
    const g = Group.create({ id: 'g1', name: 'G', memberIds: ['m1', 'm1', 'm2'] });
    expect(g.memberIds).toEqual(['m1', 'm2']);
  });

  it('sait si un membre appartient au groupe', () => {
    const g = Group.create({ id: 'g1', name: 'G', memberIds: ['m1'] });
    expect(g.hasMember('m1')).toBe(true);
    expect(g.hasMember('m9')).toBe(false);
  });

  it('ajoute et retire des membres', () => {
    const g = Group.create({ id: 'g1', name: 'G', memberIds: ['m1'] });
    const g2 = g.addMember('m2');
    expect(g2.memberIds).toEqual(['m1', 'm2']);
    const g3 = g2.removeMember('m1');
    expect(g3.memberIds).toEqual(['m2']);
  });

  it('refuse de retirer le dernier membre', () => {
    const g = Group.create({ id: 'g1', name: 'G', memberIds: ['m1'] });
    expect(() => g.removeMember('m1')).toThrow();
  });
});
