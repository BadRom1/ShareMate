import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import {
  DOCUMENT_PREFIX,
  FileSystemDocumentStorage,
  S3DocumentStorage,
  createDocumentStorage,
  documentDisposition,
  supportsDocumentExtension,
} from './document-storage.js';

/** Consomme un flux jusqu'au bout : le contenu servi doit être celui qui a été déposé. */
async function lire(stream: NodeJS.ReadableStream): Promise<string> {
  const morceaux: Buffer[] = [];
  for await (const morceau of stream) morceaux.push(Buffer.from(morceau));
  return Buffer.concat(morceaux).toString('utf8');
}

describe('extensions acceptées', () => {
  it('accepte PDF, images, bureautique et texte', () => {
    for (const extension of ['.pdf', '.PDF', '.png', '.jpeg', '.docx', '.xlsx', '.odt', '.txt']) {
      expect(supportsDocumentExtension(extension)).toBe(true);
    }
  });

  // Servis depuis le bucket, ces contenus s'exécuteraient dans le contexte de son domaine.
  it('refuse les exécutables, archives et pages web', () => {
    for (const extension of ['.html', '.svg', '.zip', '.exe', '.sh', '.js', '']) {
      expect(supportsDocumentExtension(extension)).toBe(false);
    }
  });
});

describe('Content-Disposition', () => {
  it('propose l’affichage de ce qu’un navigateur sait rendre, le téléchargement du reste', () => {
    expect(documentDisposition(`${DOCUMENT_PREFIX}x.pdf`, 'manuel.pdf')).toMatch(/^inline;/);
    expect(documentDisposition(`${DOCUMENT_PREFIX}x.png`, 'photo.png')).toMatch(/^inline;/);
    expect(documentDisposition(`${DOCUMENT_PREFIX}x.docx`, 'devis.docx')).toMatch(/^attachment;/);
  });

  it('rend le nom d’origine deux fois, dont une en UTF-8 percent-encodé', () => {
    const disposition = documentDisposition(`${DOCUMENT_PREFIX}x.pdf`, 'Manuel d’été.pdf');
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('Manuel d’été.pdf')}`);
    // Le repli ASCII ne doit porter ni caractère hors norme, ni guillemet qui couperait l'en-tête.
    const ascii = /filename="([^"]*)"/.exec(disposition)?.[1] ?? '';
    expect(ascii).toMatch(/^[\x20-\x7e]*$/);
  });

  // Un guillemet ou une contre-oblique refermerait le paramètre `filename` et laisserait le
  // reste du nom être lu comme des directives d'en-tête, choisies par celui qui a déposé.
  it('neutralise un nom de fichier qui tenterait de casser l’en-tête', () => {
    const disposition = documentDisposition(`${DOCUMENT_PREFIX}x.pdf`, 'a"; attachment; filename="b.pdf');
    expect(disposition.split('"')).toHaveLength(3);
    expect(/filename="([^"]*)"/.exec(disposition)?.[1]).toBe('a_; attachment; filename=_b.pdf');
  });
});

describe('FileSystemDocumentStorage', () => {
  let répertoire: string;
  let stockage: FileSystemDocumentStorage;

  beforeEach(() => {
    répertoire = fs.mkdtempSync(path.join(os.tmpdir(), 'sharemate-documents-'));
    stockage = new FileSystemDocumentStorage(répertoire);
  });

  afterEach(() => {
    fs.rmSync(répertoire, { recursive: true, force: true });
  });

  it('écrit sous une clé neuve et rend le contenu déposé', async () => {
    const clé = await stockage.save(Buffer.from('contenu du manuel'), '.pdf');
    expect(clé).toMatch(new RegExp(`^${DOCUMENT_PREFIX}[0-9a-f-]{36}\\.pdf$`));

    const livraison = await stockage.open(clé, 'manuel.pdf');
    expect(livraison?.kind).toBe('stream');
    if (livraison?.kind !== 'stream') throw new Error('flux attendu');
    expect(livraison.contentType).toBe('application/pdf');
    expect(livraison.size).toBe('contenu du manuel'.length);
    expect(await lire(livraison.stream)).toBe('contenu du manuel');
  });

  it('donne une clé différente à chaque dépôt du même fichier', async () => {
    const première = await stockage.save(Buffer.from('contenu'), '.pdf');
    expect(await stockage.save(Buffer.from('contenu'), '.pdf')).not.toBe(première);
  });

  it('refuse une extension non gérée', async () => {
    await expect(stockage.save(Buffer.from('x'), '.html')).rejects.toThrow(/non gérée/);
  });

  // La clé n'est jamais concaténée à un chemin sans avoir la forme exacte que `save` produit :
  // aucune de ces variantes ne doit atteindre le disque.
  it('n’ouvre et ne supprime que ce que save a pu produire', async () => {
    const clé = await stockage.save(Buffer.from('secret'), '.pdf');
    const nom = clé.slice(DOCUMENT_PREFIX.length);
    const contrefaçons = [
      nom,
      `/${clé}`,
      `${DOCUMENT_PREFIX}../${nom}`,
      `${DOCUMENT_PREFIX}..%2f${nom}`,
      `${DOCUMENT_PREFIX}./${nom}`,
      `documents//${nom}`,
      `${DOCUMENT_PREFIX}../../etc/passwd`,
    ];
    for (const contrefaçon of contrefaçons) {
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

describe('S3DocumentStorage', () => {
  /** Client S3 sans réseau : la signature d'URL est purement locale, l'envoi est observé. */
  function clientFactice() {
    const envois: unknown[] = [];
    const client = new S3Client({
      endpoint: 'https://compte.r2.cloudflarestorage.com',
      region: 'auto',
      credentials: { accessKeyId: 'clé', secretAccessKey: 'secret' },
      forcePathStyle: true,
    });
    client.send = (async (commande: unknown) => {
      envois.push(commande);
      return {};
    }) as typeof client.send;
    return { client, envois };
  }

  it('dépose l’objet sous une clé neuve, avec son type MIME', async () => {
    const { client, envois } = clientFactice();
    const stockage = new S3DocumentStorage(client, { bucket: 'sharemate' });
    const clé = await stockage.save(Buffer.from('x'), '.pdf');
    expect(clé).toMatch(new RegExp(`^${DOCUMENT_PREFIX}[0-9a-f-]{36}\\.pdf$`));
    expect((envois[0] as { input: Record<string, unknown> }).input).toMatchObject({
      Bucket: 'sharemate',
      Key: clé,
      ContentType: 'application/pdf',
    });
  });

  it('rend une URL signée à durée de vie courte plutôt que le contenu', async () => {
    const { client } = clientFactice();
    const stockage = new S3DocumentStorage(client, { bucket: 'sharemate', signedUrlTtlSeconds: 60 });
    const clé = await stockage.save(Buffer.from('x'), '.pdf');
    const livraison = await stockage.open(clé, 'manuel.pdf');
    expect(livraison?.kind).toBe('redirect');
    if (livraison?.kind !== 'redirect') throw new Error('redirection attendue');
    const url = new URL(livraison.url);
    expect(url.hostname).toBe('compte.r2.cloudflarestorage.com');
    expect(url.pathname).toContain(clé);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    // Le nom d'origine voyage dans l'URL : le bucket ne connaît que l'UUID de la clé.
    expect(url.searchParams.get('response-content-disposition')).toContain('manuel.pdf');
  });

  it('ignore une clé qui n’a pas la forme produite par save', async () => {
    const { client, envois } = clientFactice();
    const stockage = new S3DocumentStorage(client, { bucket: 'sharemate' });
    expect(await stockage.open('documents/../secret', 'x.pdf')).toBeNull();
    await stockage.delete('documents/../secret');
    expect(envois).toEqual([]);
  });
});

describe('createDocumentStorage', () => {
  let répertoire: string;

  beforeEach(() => {
    répertoire = fs.mkdtempSync(path.join(os.tmpdir(), 'sharemate-documents-'));
  });

  afterEach(() => {
    fs.rmSync(répertoire, { recursive: true, force: true });
  });

  const VARIABLES = {
    S3_BUCKET: 'sharemate',
    S3_ENDPOINT: 'https://compte.r2.cloudflarestorage.com',
    S3_ACCESS_KEY_ID: 'clé',
    S3_SECRET_ACCESS_KEY: 'secret',
  };

  it('choisit le bucket dès que ses quatre variables sont présentes', () => {
    expect(createDocumentStorage(VARIABLES, répertoire)).toBeInstanceOf(S3DocumentStorage);
  });

  it('retombe sur le disque si une seule variable manque', () => {
    for (const manquante of Object.keys(VARIABLES)) {
      const partielles = { ...VARIABLES, [manquante]: undefined };
      expect(createDocumentStorage(partielles, répertoire)).toBeInstanceOf(FileSystemDocumentStorage);
    }
  });

  it('sans bucket ni répertoire, il n’y a pas de stockage', () => {
    expect(createDocumentStorage({}, null)).toBeNull();
  });
});
