import { beforeEach, describe, expect, it } from 'vitest';
import { EQUIPMENT_STORAGE_QUOTA_BYTES, assertStorageAvailable, usedStorageBytes } from './equipment-storage.js';
import { Document } from '../domain/document/document.js';
import { Message } from '../domain/discussion/message.js';
import { Thread } from '../domain/discussion/thread.js';
import { DomainError } from '../domain/shared/domain-error.js';
import { MAX_STORED_FILE_BYTES } from '../domain/shared/stored-file.js';
import {
  InMemoryDocumentRepository,
  InMemoryMessageRepository,
  InMemoryThreadRepository,
} from './testing/in-memory.js';

let documents: InMemoryDocumentRepository;
let threads: InMemoryThreadRepository;
let messages: InMemoryMessageRepository;
let clés = 0;

beforeEach(async () => {
  documents = new InMemoryDocumentRepository();
  threads = new InMemoryThreadRepository();
  messages = new InMemoryMessageRepository(threads);
  await threads.save(
    Thread.create({ id: 't1', equipmentId: 'e1', authorId: 'm1', title: 'Panne', createdAt: new Date('2026-07-01') }),
  );
});

async function unDocument(sizeBytes: number) {
  clés += 1;
  await documents.save(
    Document.create({
      id: `d${clés}`,
      equipmentId: 'e1',
      authorId: 'm1',
      name: `Document ${clés}`,
      category: 'MANUAL',
      content: {
        type: 'FILE',
        storageKey: `documents/${clés}.pdf`,
        fileName: 'manuel.pdf',
        contentType: 'application/pdf',
        sizeBytes,
      },
      createdAt: new Date('2026-07-01'),
    }),
  );
}

async function unePièceJointe(sizeBytes: number) {
  clés += 1;
  await messages.save(
    Message.create({
      id: `msg${clés}`,
      threadId: 't1',
      authorId: 'm1',
      body: 'Voilà',
      createdAt: new Date('2026-07-01'),
      attachment: {
        storageKey: `attachments/${clés}.png`,
        fileName: 'panne.png',
        contentType: 'image/png',
        sizeBytes,
      },
    }),
  );
}

describe('place occupée par un équipement', () => {
  it('additionne les documents et les pièces jointes', async () => {
    await unDocument(1000);
    await unePièceJointe(500);
    expect(await usedStorageBytes(documents, messages, 'e1')).toBe(1500);
  });

  it('ne compte ni les liens, ni les messages sans fichier', async () => {
    await documents.save(
      Document.create({
        id: 'lien',
        equipmentId: 'e1',
        authorId: 'm1',
        name: 'Catalogue',
        category: 'OTHER',
        content: { type: 'LINK', url: 'https://exemple.fr' },
        createdAt: new Date('2026-07-01'),
      }),
    );
    await messages.save(
      Message.create({
        id: 'texte',
        threadId: 't1',
        authorId: 'm1',
        body: 'Bonjour',
        createdAt: new Date('2026-07-01'),
      }),
    );
    expect(await usedStorageBytes(documents, messages, 'e1')).toBe(0);
  });

  it('ne compte que l’équipement demandé', async () => {
    await unDocument(1000);
    expect(await usedStorageBytes(documents, messages, 'e2')).toBe(0);
  });
});

describe('place disponible', () => {
  it('laisse passer tant qu’il reste de la place', async () => {
    await unDocument(1000);
    await expect(assertStorageAvailable(documents, messages, 'e1', 1000)).resolves.toBeUndefined();
  });

  /**
   * Remplit l'équipement jusqu'au plafond. Un seul fichier ne peut pas y suffire : le domaine le
   * borne bien plus bas (25 Mo).
   */
  async function remplir(déposer: (sizeBytes: number) => Promise<void>) {
    const dépôts = EQUIPMENT_STORAGE_QUOTA_BYTES / MAX_STORED_FILE_BYTES;
    for (let i = 0; i < dépôts; i += 1) await déposer(MAX_STORED_FILE_BYTES);
  }

  // Sans ce partage, les messages seraient la façon la moins chère de remplir le bucket : le
  // dossier serait plafonné, les discussions non.
  it('refuse le dépôt d’un document que les pièces jointes ont déjà rempli', async () => {
    await remplir(unePièceJointe);
    await expect(assertStorageAvailable(documents, messages, 'e1', 1)).rejects.toThrow(DomainError);
  });

  it('refuse la pièce jointe que les documents ont déjà remplie', async () => {
    await remplir(unDocument);
    await expect(assertStorageAvailable(documents, messages, 'e1', 1)).rejects.toThrow(DomainError);
  });

  it('dit combien de place il reste', async () => {
    const dépôts = EQUIPMENT_STORAGE_QUOTA_BYTES / MAX_STORED_FILE_BYTES;
    for (let i = 0; i < dépôts - 1; i += 1) await unDocument(MAX_STORED_FILE_BYTES);
    // Il reste la place d'un dernier fichier : le refus doit le dire plutôt que rester vague.
    await expect(assertStorageAvailable(documents, messages, 'e1', MAX_STORED_FILE_BYTES + 1)).rejects.toThrow(
      /reste 25 Mo/,
    );
  });
});
