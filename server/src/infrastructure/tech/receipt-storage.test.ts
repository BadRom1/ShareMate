import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RECEIPT_KEY_PREFIX, RECEIPT_PREFIX, ReceiptStorage, createReceiptStorage } from './receipt-storage.js';
import { FileObjectStore, createS3ObjectStore } from './object-store.js';

/** Consomme un flux jusqu'au bout. */
async function lire(stream: NodeJS.ReadableStream): Promise<string> {
  const morceaux: Buffer[] = [];
  for await (const morceau of stream) morceaux.push(Buffer.from(morceau));
  return Buffer.concat(morceaux).toString('utf8');
}

let répertoire: string;
let stockage: ReceiptStorage;

beforeEach(() => {
  répertoire = fs.mkdtempSync(path.join(os.tmpdir(), 'sharemate-justificatifs-'));
  stockage = new ReceiptStorage(new FileObjectStore(répertoire, RECEIPT_KEY_PREFIX));
});

afterEach(() => {
  fs.rmSync(répertoire, { recursive: true, force: true });
});

describe('ReceiptStorage', () => {
  it('n’accepte que les images et le PDF', () => {
    for (const extension of ['.png', '.PNG', '.jpg', '.jpeg', '.webp', '.pdf']) {
      expect(stockage.supports(extension)).toBe(true);
    }
    for (const extension of ['.docx', '.svg', '.html', '.zip', '']) {
      expect(stockage.supports(extension)).toBe(false);
    }
  });

  // Le chemin public est l'identifiant du justificatif, porté par la dépense en base ; il n'a pas
  // bougé au passage dans le bucket, où la même valeur devient `receipts/<uuid>.<ext>`.
  it('rend un chemin public en /uploads/ et range l’objet sous receipts/', async () => {
    const chemin = await stockage.save(Buffer.from('le reçu'), '.png');
    expect(chemin).toMatch(/^\/uploads\/[0-9a-f-]{36}\.png$/);
    expect(fs.readdirSync(répertoire)).toEqual([chemin.slice(RECEIPT_PREFIX.length)]);

    const livraison = await stockage.open(chemin);
    if (livraison?.kind !== 'stream') throw new Error('flux attendu');
    expect(livraison.contentType).toBe('image/png');
    expect(await lire(livraison.stream)).toBe('le reçu');
  });

  it('donne un nom différent à chaque dépôt du même fichier', async () => {
    const première = await stockage.save(Buffer.from('reçu'), '.png');
    expect(await stockage.save(Buffer.from('reçu'), '.png')).not.toBe(première);
  });

  it('refuse une extension non gérée', async () => {
    await expect(stockage.save(Buffer.from('x'), '.svg')).rejects.toThrow(/non gérée/);
  });

  // Le chemin n'est traduit en clé qu'après avoir la forme exacte que `save` produit : aucune de
  // ces variantes ne doit atteindre le magasin.
  it('n’ouvre et ne supprime que ce que save a pu produire', async () => {
    const chemin = await stockage.save(Buffer.from('secret'), '.png');
    const nom = chemin.slice(RECEIPT_PREFIX.length);
    for (const contrefaçon of [
      nom,
      `//uploads/${nom}`,
      `/uploads//${nom}`,
      `/./uploads/${nom}`,
      `/uploads/./${nom}`,
      `/uploads/../${nom}`,
      '/uploads/../secret.txt',
      '/uploads/%2e%2e%2fsecret.txt',
      `/uploads/${crypto.randomUUID()}.svg`,
      `receipts/${nom}`,
    ]) {
      expect(await stockage.open(contrefaçon)).toBeNull();
      await stockage.delete(contrefaçon);
    }
    const intact = await stockage.open(chemin);
    if (intact?.kind !== 'stream') throw new Error('flux attendu');
    expect(await lire(intact.stream)).toBe('secret');
  });

  it('supprime, et une seconde suppression reste sans effet', async () => {
    const chemin = await stockage.save(Buffer.from('x'), '.png');
    await stockage.delete(chemin);
    expect(await stockage.open(chemin)).toBeNull();
    await expect(stockage.delete(chemin)).resolves.toBeUndefined();
  });
});

describe('bascule du volume vers le bucket', () => {
  /** Justificatif déposé avant la bascule : il dort sur le volume, pas dans le nouveau magasin. */
  function aprèsBascule() {
    const volume = new FileObjectStore(path.join(répertoire, 'volume'), RECEIPT_KEY_PREFIX);
    const bucket = new FileObjectStore(path.join(répertoire, 'bucket'), RECEIPT_KEY_PREFIX);
    const ancien = `/uploads/${crypto.randomUUID()}.png`;
    // Le fichier est posé à la main : il représente ce qui dormait déjà là avant la bascule, donc
    // avant que le magasin n'ait eu l'occasion de créer quoi que ce soit.
    fs.mkdirSync(path.join(répertoire, 'volume'), { recursive: true });
    fs.writeFileSync(path.join(répertoire, 'volume', ancien.slice(RECEIPT_PREFIX.length)), 'déposé avant');
    return { ancien, bucket, migré: new ReceiptStorage(bucket, volume) };
  }

  it('sert encore les justificatifs restés sur le volume', async () => {
    const { migré, ancien } = aprèsBascule();
    const livraison = await migré.open(ancien);
    if (livraison?.kind !== 'stream') throw new Error('flux attendu');
    expect(await lire(livraison.stream)).toBe('déposé avant');
  });

  it('dépose les nouveaux dans le bucket, et lui seul', async () => {
    const { migré, bucket } = aprèsBascule();
    const chemin = await migré.save(Buffer.from('déposé après'), '.png');
    expect(await bucket.exists(`${RECEIPT_KEY_PREFIX}${chemin.slice(RECEIPT_PREFIX.length)}`)).toBe(true);
    expect(fs.readdirSync(path.join(répertoire, 'volume'))).toHaveLength(1);
  });

  // Sans cela, un justificatif « supprimé » avec sa dépense resterait lisible depuis le volume.
  it('purge des deux côtés à la suppression', async () => {
    const { migré, ancien } = aprèsBascule();
    await migré.delete(ancien);
    expect(await migré.open(ancien)).toBeNull();
    expect(fs.readdirSync(path.join(répertoire, 'volume'))).toEqual([]);
  });
});

describe('createReceiptStorage', () => {
  /** Magasin distant quelconque : la fabrique ne fait que le préférer au disque. */
  const BUCKET = createS3ObjectStore({
    S3_BUCKET: 'sharemate',
    S3_ENDPOINT: 'https://compte.r2.cloudflarestorage.com',
    S3_ACCESS_KEY_ID: 'clé',
    S3_SECRET_ACCESS_KEY: 'secret',
  });

  it('préfère le bucket quand il y en a un, le répertoire sinon', () => {
    expect(createReceiptStorage(BUCKET, répertoire)).toBeInstanceOf(ReceiptStorage);
    expect(createReceiptStorage(null, répertoire)).toBeInstanceOf(ReceiptStorage);
  });

  it('sans bucket ni répertoire, il n’y a rien à servir ni à purger', () => {
    expect(createReceiptStorage(null, null)).toBeNull();
  });
});
