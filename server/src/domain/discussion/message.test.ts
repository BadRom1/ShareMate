import { describe, expect, it } from 'vitest';
import { Message } from './message.js';
import { DomainError } from '../shared/domain-error.js';

const base = {
  id: 'm1',
  threadId: 't1',
  authorId: 'u1',
  createdAt: new Date('2026-01-01T10:00:00Z'),
};

describe('Message', () => {
  it('normalise le corps (trim) et pose editedAt à null par défaut', () => {
    const message = Message.create({ ...base, body: '  Bonjour  ' });
    expect(message.body).toBe('Bonjour');
    expect(message.editedAt).toBeNull();
  });

  it('refuse un corps vide', () => {
    expect(() => Message.create({ ...base, body: '   ' })).toThrow(DomainError);
  });

  it('refuse un corps trop long', () => {
    expect(() => Message.create({ ...base, body: 'x'.repeat(4001) })).toThrow(DomainError);
  });

  it('edit met à jour le corps et horodate editedAt', () => {
    const message = Message.create({ ...base, body: 'Avant' });
    const edited = message.edit('Après', new Date('2026-01-02T10:00:00Z'));
    expect(edited.body).toBe('Après');
    expect(edited.editedAt).toEqual(new Date('2026-01-02T10:00:00Z'));
    expect(edited.createdAt).toEqual(message.createdAt);
  });
});

describe('Message — pièce jointe', () => {
  const FICHIER = {
    storageKey: 'attachments/8f14e45f-ea3d-4b0a-9c2e-1a2b3c4d5e6f.png',
    fileName: 'panne.png',
    contentType: 'image/png',
    sizeBytes: 240_000,
  };

  function avecFichier(body = 'Regardez ça', attachment = FICHIER) {
    return Message.create({
      id: 'msg1',
      threadId: 't1',
      authorId: 'm1',
      body,
      createdAt: new Date('2026-07-01T08:00:00Z'),
      attachment,
    });
  }

  it('porte le fichier et sa référence à purger', () => {
    const message = avecFichier();
    expect(message.attachment).toEqual(FICHIER);
    expect(message.storageKey).toBe(FICHIER.storageKey);
  });

  it('n’en porte aucune par défaut', () => {
    const message = Message.create({
      id: 'msg1',
      threadId: 't1',
      authorId: 'm1',
      body: 'Sans fichier',
      createdAt: new Date('2026-07-01T08:00:00Z'),
    });
    expect(message.attachment).toBeNull();
    expect(message.storageKey).toBeNull();
  });

  // Envoyer une photo sans commentaire est un geste normal ; exiger un texte ferait écrire
  // « voilà » à tout le monde.
  it('accepte un corps vide quand un fichier est joint, jamais sans', () => {
    expect(avecFichier('   ').body).toBe('');
    expect(() =>
      Message.create({
        id: 'msg1',
        threadId: 't1',
        authorId: 'm1',
        body: '  ',
        createdAt: new Date('2026-07-01T08:00:00Z'),
      }),
    ).toThrow(DomainError);
  });

  it('applique les bornes d’un fichier stocké', () => {
    expect(() => avecFichier('x', { ...FICHIER, storageKey: ' ' })).toThrow(DomainError);
    expect(() => avecFichier('x', { ...FICHIER, fileName: '' })).toThrow(DomainError);
    expect(() => avecFichier('x', { ...FICHIER, sizeBytes: 0 })).toThrow(DomainError);
    expect(() => avecFichier('x', { ...FICHIER, sizeBytes: 26 * 1024 * 1024 })).toThrow(DomainError);
  });

  // La pièce jointe a été vue par le cercle : la changer sous le même message réécrirait ce que
  // les autres ont lu.
  it('garde sa pièce jointe à l’édition, et laisse alors le corps se vider', () => {
    const édité = avecFichier().edit('  ', new Date('2026-07-02T08:00:00Z'));
    expect(édité.attachment).toEqual(FICHIER);
    expect(édité.body).toBe('');
  });
});
