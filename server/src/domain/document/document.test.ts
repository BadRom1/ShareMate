import { describe, expect, it } from 'vitest';
import { Document, MAX_DOCUMENT_SIZE_BYTES, normalizeDocumentUrl } from './document.js';
import type { DocumentContent } from './document.js';
import { DomainError } from '../shared/domain-error.js';

const FICHIER: DocumentContent = {
  type: 'FILE',
  storageKey: 'documents/8f14e45f-ea3d-4b0a-9c2e-1a2b3c4d5e6f.pdf',
  fileName: 'manuel-kx027.pdf',
  contentType: 'application/pdf',
  sizeBytes: 4_200_000,
};

const LIEN: DocumentContent = { type: 'LINK', url: 'https://kubota-eu.com/pieces' };

function make(overrides: Partial<Parameters<typeof Document.create>[0]> = {}) {
  return Document.create({
    id: 'd1',
    equipmentId: 'e1',
    authorId: 'm1',
    name: 'Manuel d’utilisation',
    category: 'MANUAL',
    content: FICHIER,
    createdAt: new Date('2026-07-01T08:00:00Z'),
    ...overrides,
  });
}

describe('Document', () => {
  it('normalise le nom', () => {
    expect(make({ name: '  Manuel d’utilisation  ' }).name).toBe('Manuel d’utilisation');
  });

  it('refuse un nom vide ou trop long', () => {
    expect(() => make({ name: '   ' })).toThrow(DomainError);
    expect(() => make({ name: 'x'.repeat(201) })).toThrow(DomainError);
  });

  it('refuse une catégorie inconnue', () => {
    expect(() => make({ category: 'CARTE_GRISE' as never })).toThrow(DomainError);
  });

  describe('fichier déposé', () => {
    it('conserve la référence de stockage et le poids', () => {
      const document = make();
      expect(document.storageKey).toBe('documents/8f14e45f-ea3d-4b0a-9c2e-1a2b3c4d5e6f.pdf');
      expect(document.sizeBytes).toBe(4_200_000);
    });

    it('refuse une référence, un nom de fichier ou un type manquants', () => {
      expect(() => make({ content: { ...FICHIER, storageKey: '  ' } as DocumentContent })).toThrow(DomainError);
      expect(() => make({ content: { ...FICHIER, fileName: '' } as DocumentContent })).toThrow(DomainError);
      expect(() => make({ content: { ...FICHIER, contentType: ' ' } as DocumentContent })).toThrow(DomainError);
    });

    it('refuse un poids non entier, nul ou négatif', () => {
      for (const sizeBytes of [0, -1, 12.5]) {
        expect(() => make({ content: { ...FICHIER, sizeBytes } as DocumentContent })).toThrow(DomainError);
      }
    });

    it('refuse un fichier au-delà du plafond', () => {
      expect(() =>
        make({ content: { ...FICHIER, sizeBytes: MAX_DOCUMENT_SIZE_BYTES + 1 } as DocumentContent }),
      ).toThrow(DomainError);
    });
  });

  describe('lien externe', () => {
    it('ne pèse rien dans le stockage et n’a pas de référence à purger', () => {
      const document = make({ content: LIEN });
      expect(document.storageKey).toBeNull();
      expect(document.sizeBytes).toBe(0);
    });

    // Un lien du dossier est cliquable par tout le cercle : les schémas exécutables ou
    // fabriqués y feraient passer du code ou une fausse page pour un document partagé.
    it('n’accepte que http et https', () => {
      expect(normalizeDocumentUrl('  https://exemple.fr/manuel.pdf  ')).toBe('https://exemple.fr/manuel.pdf');
      expect(normalizeDocumentUrl('http://192.168.1.10/notice')).toBe('http://192.168.1.10/notice');
      for (const url of [
        'javascript:alert(document.cookie)',
        'data:text/html;base64,PHNjcmlwdD4=',
        'file:///etc/passwd',
        'ftp://exemple.fr/manuel.pdf',
      ]) {
        expect(() => normalizeDocumentUrl(url)).toThrow(DomainError);
      }
    });

    it('refuse une adresse vide, illisible ou trop longue', () => {
      expect(() => normalizeDocumentUrl('   ')).toThrow(DomainError);
      expect(() => normalizeDocumentUrl('pas une url')).toThrow(DomainError);
      expect(() => normalizeDocumentUrl(`https://exemple.fr/${'x'.repeat(2000)}`)).toThrow(DomainError);
    });
  });

  describe('mise à jour', () => {
    it('renomme et reclasse sans toucher au contenu ni à la date de dépôt', () => {
      const updated = make().update({ name: 'Attestation 2026', category: 'INSURANCE' });
      expect(updated.name).toBe('Attestation 2026');
      expect(updated.category).toBe('INSURANCE');
      expect(updated.content).toEqual(make().content);
      expect(updated.createdAt).toEqual(make().createdAt);
    });

    it('laisse inchangé ce que la mise à jour ne mentionne pas', () => {
      const updated = make().update({ name: 'Autre nom' });
      expect(updated.category).toBe('MANUAL');
    });

    it('applique les mêmes règles qu’à la création', () => {
      expect(() => make().update({ name: '  ' })).toThrow(DomainError);
    });
  });
});
