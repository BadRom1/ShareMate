import { beforeEach, describe, expect, it } from 'vitest';
import { DocumentService, EQUIPMENT_STORAGE_QUOTA_BYTES } from './document-service.js';
import { MAX_DOCUMENT_SIZE_BYTES } from '../domain/document/document.js';
import type { ExternalLink, StoredFile } from '../domain/document/document.js';
import { DomainError, ForbiddenError, NotFoundError } from '../domain/shared/domain-error.js';
import { makeFixture } from './testing/fixture.js';
import { InMemoryDocumentRepository, InMemoryObjectStorage } from './testing/in-memory.js';

let clésTéléversées = 0;

/** Fichier déposé, dont la clé de stockage est neuve à chaque appel (comme un téléversement). */
function fichier(overrides: Partial<Omit<StoredFile, 'type'>> = {}): StoredFile {
  clésTéléversées += 1;
  return {
    type: 'FILE',
    storageKey: `documents/téléversé-${clésTéléversées}.pdf`,
    fileName: 'manuel.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1_000_000,
    ...overrides,
  };
}

function lien(url = 'https://kubota-eu.com/pieces'): ExternalLink {
  return { type: 'LINK', url };
}

async function setup() {
  const fx = await makeFixture();
  const documents = new InMemoryDocumentRepository();
  const storage = new InMemoryObjectStorage();
  const service = new DocumentService(documents, fx.equipments, fx.idGenerator, fx.clock, storage);
  return { service, documents, storage, equipments: fx.equipments };
}

describe('DocumentService', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('dépose un fichier et un lien dans le même dossier', async () => {
    await ctx.service.addDocument({ equipmentId: 'e1', name: 'Manuel', category: 'MANUAL', content: fichier() }, 'm1');
    await ctx.service.addDocument({ equipmentId: 'e1', name: 'Pièces', category: 'OTHER', content: lien() }, 'm2');
    const list = await ctx.service.listDocuments('e1', 'm1');
    expect(list.map((d) => d.name)).toEqual(['Pièces', 'Manuel']);
    expect(list.map((d) => d.content.type)).toEqual(['LINK', 'FILE']);
  });

  it('attribue le document à son déposant', async () => {
    const document = await ctx.service.addDocument(
      { equipmentId: 'e1', name: 'Manuel', category: 'MANUAL', content: fichier() },
      'm2',
    );
    expect(document.authorId).toBe('m2');
  });

  it('à défaut de nom saisi, retombe sur le nom du fichier ou le domaine du lien', async () => {
    const fichierSansNom = await ctx.service.addDocument(
      { equipmentId: 'e1', name: '  ', category: 'MANUAL', content: fichier({ fileName: 'notice-kx027.pdf' }) },
      'm1',
    );
    const lienSansNom = await ctx.service.addDocument(
      { equipmentId: 'e1', category: 'OTHER', content: lien('https://www.youtube.com/watch?v=abc') },
      'm1',
    );
    expect(fichierSansNom.name).toBe('notice-kx027.pdf');
    expect(lienSansNom.name).toBe('www.youtube.com');
  });

  // Sans cette borne, recopier la clé d'un fichier d'un autre cercle dans son propre document
  // suffirait à s'en ouvrir la lecture, et la purge ne saurait plus qui nomme quoi.
  it('refuse de rattacher deux documents au même fichier stocké', async () => {
    const contenu = fichier();
    await ctx.service.addDocument({ equipmentId: 'e1', name: 'A', category: 'OTHER', content: contenu }, 'm1');
    await expect(
      ctx.service.addDocument({ equipmentId: 'e1', name: 'B', category: 'OTHER', content: contenu }, 'm1'),
    ).rejects.toThrow(DomainError);
  });

  it('renomme et reclasse un document', async () => {
    const document = await ctx.service.addDocument(
      { equipmentId: 'e1', name: 'SCAN_0003.pdf', category: 'OTHER', content: fichier() },
      'm1',
    );
    const updated = await ctx.service.updateDocument(document.id, 'm2', {
      name: 'Certificat d’assurance',
      category: 'INSURANCE',
    });
    expect(updated.name).toBe('Certificat d’assurance');
    expect(updated.category).toBe('INSURANCE');
  });

  it('supprime le document et purge l’objet stocké', async () => {
    const contenu = fichier();
    ctx.storage.add(contenu.storageKey);
    const document = await ctx.service.addDocument(
      { equipmentId: 'e1', name: 'Manuel', category: 'MANUAL', content: contenu },
      'm1',
    );
    await ctx.service.deleteDocument(document.id, 'm2');
    expect(await ctx.service.listDocuments('e1', 'm1')).toEqual([]);
    expect(ctx.storage.keys.size).toBe(0);
  });

  it('supprimer un lien ne touche à rien dans le stockage', async () => {
    ctx.storage.add('documents/intact.pdf');
    const document = await ctx.service.addDocument(
      { equipmentId: 'e1', name: 'Pièces', category: 'OTHER', content: lien() },
      'm1',
    );
    await ctx.service.deleteDocument(document.id, 'm1');
    expect([...ctx.storage.keys]).toEqual(['documents/intact.pdf']);
  });

  describe('cercle de l’équipement', () => {
    it('refuse le dépôt à un membre hors du cercle', async () => {
      await expect(
        ctx.service.addDocument({ equipmentId: 'e1', name: 'X', category: 'OTHER', content: lien() }, 'm3'),
      ).rejects.toThrow(ForbiddenError);
    });

    it('hors du cercle, ni lecture, ni renommage, ni suppression', async () => {
      const document = await ctx.service.addDocument(
        { equipmentId: 'e1', name: 'Manuel', category: 'MANUAL', content: fichier() },
        'm1',
      );
      await expect(ctx.service.listDocuments('e1', 'm3')).rejects.toThrow(ForbiddenError);
      await expect(ctx.service.documentForMember(document.id, 'm3')).rejects.toThrow(ForbiddenError);
      await expect(ctx.service.updateDocument(document.id, 'm3', { name: 'X' })).rejects.toThrow(ForbiddenError);
      await expect(ctx.service.deleteDocument(document.id, 'm3')).rejects.toThrow(ForbiddenError);
    });

    // Le refus porte le message de l'absence : détenir un identifiant ne doit rien apprendre.
    it('masque le refus derrière l’absence du document', async () => {
      const document = await ctx.service.addDocument(
        { equipmentId: 'e1', name: 'Manuel', category: 'MANUAL', content: fichier() },
        'm1',
      );
      await expect(ctx.service.documentForMember(document.id, 'm3')).rejects.toThrow(
        `Document introuvable : ${document.id}`,
      );
    });

    it('signale un équipement ou un document introuvable', async () => {
      await expect(
        ctx.service.addDocument({ equipmentId: 'nope', name: 'X', category: 'OTHER', content: lien() }, 'm1'),
      ).rejects.toThrow(NotFoundError);
      await expect(ctx.service.documentForMember('nope', 'm1')).rejects.toThrow(NotFoundError);
    });
  });

  describe('place disponible', () => {
    it('autorise un téléversement tant que le dossier n’est pas plein', async () => {
      await expect(ctx.service.assertCanStore('e1', 'm1', 10_000)).resolves.toBeUndefined();
    });

    it('refuse le téléversement qui ferait déborder le dossier, et rend la place aux suppressions', async () => {
      // Le quota se remplit par la somme des dépôts : un seul fichier ne peut pas l'atteindre,
      // le domaine le plafonne bien plus bas (25 Mo).
      const gros = { sizeBytes: MAX_DOCUMENT_SIZE_BYTES };
      const dépôts = EQUIPMENT_STORAGE_QUOTA_BYTES / MAX_DOCUMENT_SIZE_BYTES;
      const documents = [];
      for (let i = 0; i < dépôts; i += 1) {
        documents.push(
          await ctx.service.addDocument(
            { equipmentId: 'e1', name: `Photo ${i}`, category: 'PHOTO', content: fichier(gros) },
            'm1',
          ),
        );
      }
      await expect(ctx.service.assertCanStore('e1', 'm1', 1)).rejects.toThrow(DomainError);

      await ctx.service.deleteDocument(documents[0]!.id, 'm1');
      await expect(ctx.service.assertCanStore('e1', 'm1', MAX_DOCUMENT_SIZE_BYTES)).resolves.toBeUndefined();
    });

    it('les liens ne pèsent rien dans le décompte', async () => {
      for (let i = 0; i < 5; i += 1) {
        await ctx.service.addDocument(
          { equipmentId: 'e1', name: `Lien ${i}`, category: 'OTHER', content: lien(`https://exemple.fr/${i}`) },
          'm1',
        );
      }
      await expect(ctx.service.assertCanStore('e1', 'm1', EQUIPMENT_STORAGE_QUOTA_BYTES)).resolves.toBeUndefined();
    });

    it('refuse le téléversement d’un membre hors du cercle', async () => {
      await expect(ctx.service.assertCanStore('e1', 'm3', 10)).rejects.toThrow(ForbiddenError);
    });
  });

  it('sans stockage configuré, la suppression reste possible', async () => {
    const fx = await makeFixture();
    const documents = new InMemoryDocumentRepository();
    const sansStockage = new DocumentService(documents, fx.equipments, fx.idGenerator, fx.clock);
    const document = await sansStockage.addDocument(
      { equipmentId: 'e1', name: 'Manuel', category: 'MANUAL', content: fichier() },
      'm1',
    );
    await expect(sansStockage.deleteDocument(document.id, 'm1')).resolves.toBeUndefined();
  });
});
