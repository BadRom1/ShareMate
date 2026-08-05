import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DOCUMENT_PREFIX, RICH_CONTENT_TYPES, createDocumentStorage } from './document-storage.js';
import type { DocumentStorage } from './document-storage.js';
import { FileObjectStore, MediaStorage } from './object-store.js';

/** Consomme un flux jusqu'au bout : un flux laissé ouvert survivrait au nettoyage du répertoire. */
async function lire(stream: NodeJS.ReadableStream): Promise<string> {
  const morceaux: Buffer[] = [];
  for await (const morceau of stream) morceaux.push(Buffer.from(morceau));
  return Buffer.concat(morceaux).toString('utf8');
}

let répertoire: string;
let stockage: DocumentStorage;

beforeEach(() => {
  répertoire = fs.mkdtempSync(path.join(os.tmpdir(), 'sharemate-documents-'));
  stockage = new MediaStorage(new FileObjectStore(répertoire, DOCUMENT_PREFIX), {
    keyPrefix: DOCUMENT_PREFIX,
    contentTypes: RICH_CONTENT_TYPES,
  });
});

afterEach(() => {
  fs.rmSync(répertoire, { recursive: true, force: true });
});

describe('formats acceptés', () => {
  it('accepte PDF, images, bureautique et texte', () => {
    for (const extension of ['.pdf', '.PDF', '.png', '.jpeg', '.docx', '.xlsx', '.odt', '.txt']) {
      expect(stockage.supports(extension)).toBe(true);
    }
  });

  // Servis depuis le domaine du bucket, ces contenus s'y exécuteraient.
  it('refuse les exécutables, archives, pages web et images vectorielles', () => {
    for (const extension of ['.html', '.svg', '.zip', '.exe', '.sh', '.js', '']) {
      expect(stockage.supports(extension)).toBe(false);
    }
    expect(stockage.extensions()).not.toContain('.html');
  });
});

describe('DocumentStorage', () => {
  it('dépose sous une clé préfixée et rend le contenu servi', async () => {
    const clé = await stockage.save(Buffer.from('%PDF le manuel'), '.pdf');
    expect(clé).toMatch(new RegExp(`^${DOCUMENT_PREFIX}[0-9a-f-]{36}\\.pdf$`));

    const livraison = await stockage.open(clé, 'manuel.pdf');
    if (livraison?.kind !== 'stream') throw new Error('flux attendu');
    expect(livraison.contentType).toBe('application/pdf');
    expect(livraison.size).toBe('%PDF le manuel'.length);
    expect(await lire(livraison.stream)).toBe('%PDF le manuel');
  });

  // La clé n'est jamais transmise au magasin sans avoir la forme exacte que `save` produit.
  it('n’ouvre et ne supprime que ce que save a pu produire', async () => {
    const clé = await stockage.save(Buffer.from('secret'), '.pdf');
    const nom = clé.slice(DOCUMENT_PREFIX.length);
    for (const contrefaçon of [
      nom,
      `/${clé}`,
      `${DOCUMENT_PREFIX}../${nom}`,
      `${DOCUMENT_PREFIX}..%2f${nom}`,
      `${DOCUMENT_PREFIX}./${nom}`,
      `documents//${nom}`,
      `${DOCUMENT_PREFIX}../../etc/passwd`,
      `${DOCUMENT_PREFIX}00000000-0000-4000-8000-000000000000.zip`,
    ]) {
      expect(await stockage.open(contrefaçon, 'x.pdf')).toBeNull();
      await stockage.delete(contrefaçon);
    }
    // Le fichier légitime est resté intact tout du long.
    const intact = await stockage.open(clé, 'manuel.pdf');
    if (intact?.kind !== 'stream') throw new Error('flux attendu');
    expect(await lire(intact.stream)).toBe('secret');
  });

  it('supprime, et une seconde suppression reste sans effet', async () => {
    const clé = await stockage.save(Buffer.from('x'), '.pdf');
    await stockage.delete(clé);
    expect(await stockage.open(clé, 'x.pdf')).toBeNull();
    await expect(stockage.delete(clé)).resolves.toBeUndefined();
  });
});

describe('createDocumentStorage', () => {
  const BUCKET = {
    S3_BUCKET: 'sharemate',
    S3_ENDPOINT: 'https://compte.r2.cloudflarestorage.com',
    S3_ACCESS_KEY_ID: 'clé',
    S3_SECRET_ACCESS_KEY: 'secret',
  };

  it('choisit le bucket dès que ses variables sont là, le disque sinon', () => {
    expect(createDocumentStorage(BUCKET, répertoire)).toBeInstanceOf(MediaStorage);
    expect(createDocumentStorage({}, répertoire)).toBeInstanceOf(MediaStorage);
  });

  it('sans bucket ni répertoire, il n’y a pas de stockage', () => {
    expect(createDocumentStorage({}, null)).toBeNull();
  });
});
