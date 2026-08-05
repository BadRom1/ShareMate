import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import {
  FileObjectStore,
  MediaStorage,
  S3ObjectStore,
  contentDisposition,
  createS3ObjectStore,
} from './object-store.js';
import type { MediaType } from './object-store.js';

/** Consomme un flux jusqu'au bout : le contenu servi doit être celui qui a été déposé. */
async function lire(stream: NodeJS.ReadableStream): Promise<string> {
  const morceaux: Buffer[] = [];
  for await (const morceau of stream) morceaux.push(Buffer.from(morceau));
  return Buffer.concat(morceaux).toString('utf8');
}

const TYPES: Record<string, MediaType> = {
  '.pdf': { type: 'application/pdf', inline: true },
  '.docx': { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', inline: false },
};

let répertoire: string;

beforeEach(() => {
  répertoire = fs.mkdtempSync(path.join(os.tmpdir(), 'sharemate-objets-'));
});

afterEach(() => {
  fs.rmSync(répertoire, { recursive: true, force: true });
});

describe('Content-Disposition', () => {
  it('propose l’affichage de ce qu’un navigateur sait rendre, le téléchargement du reste', () => {
    expect(contentDisposition('manuel.pdf', true)).toMatch(/^inline;/);
    expect(contentDisposition('devis.docx', false)).toMatch(/^attachment;/);
  });

  it('rend le nom d’origine deux fois, dont une en UTF-8 percent-encodé', () => {
    const disposition = contentDisposition('Manuel d’été.pdf', true);
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('Manuel d’été.pdf')}`);
    const ascii = /filename="([^"]*)"/.exec(disposition)?.[1] ?? '';
    expect(ascii).toMatch(/^[\x20-\x7e]*$/);
  });

  // Un guillemet ou une contre-oblique refermerait le paramètre `filename` et laisserait le reste
  // du nom être lu comme des directives d'en-tête, choisies par celui qui a déposé.
  it('neutralise un nom de fichier qui tenterait de casser l’en-tête', () => {
    const disposition = contentDisposition('a"; attachment; filename="b.pdf', false);
    expect(disposition.split('"')).toHaveLength(3);
  });
});

describe('FileObjectStore', () => {
  it('range à plat, le préfixe de la clé retiré', async () => {
    const store = new FileObjectStore(répertoire, 'receipts/');
    await store.put('receipts/abc.pdf', Buffer.from('contenu'), 'application/pdf');

    expect(fs.readdirSync(répertoire)).toEqual(['abc.pdf']);
    expect(await store.exists('receipts/abc.pdf')).toBe(true);
    expect(await lire((await store.read('receipts/abc.pdf'))!.stream)).toBe('contenu');
  });

  it('ne signe aucune URL : le disque n’est joignable que par l’API', async () => {
    const store = new FileObjectStore(répertoire, 'receipts/');
    expect(await store.signedUrl()).toBeNull();
  });

  // La forme exacte d'une clé est validée au-dessus ; cette borne-ci est la seconde, celle qui
  // tient quelle que soit l'erreur commise par l'appelant.
  it('n’atteint aucun fichier hors de son répertoire ni hors de son préfixe', async () => {
    const store = new FileObjectStore(répertoire, 'receipts/');
    fs.writeFileSync(path.join(répertoire, '..', 'secret.txt'), 'SECRET');
    try {
      for (const clé of [
        'abc.pdf',
        'documents/abc.pdf',
        'receipts/../secret.txt',
        'receipts/../../secret.txt',
        'receipts//abc.pdf',
        'receipts/./abc.pdf',
        'receipts/',
      ]) {
        expect(await store.exists(clé)).toBe(false);
        expect(await store.read(clé)).toBeNull();
        await store.remove(clé);
        await expect(store.put(clé, Buffer.from('x'), 'text/plain')).rejects.toThrow();
      }
      expect(fs.existsSync(path.join(répertoire, '..', 'secret.txt'))).toBe(true);
    } finally {
      fs.rmSync(path.join(répertoire, '..', 'secret.txt'), { force: true });
    }
  });

  it('supprime, et une seconde suppression reste sans effet', async () => {
    const store = new FileObjectStore(répertoire, 'receipts/');
    await store.put('receipts/abc.pdf', Buffer.from('x'), 'application/pdf');
    await store.remove('receipts/abc.pdf');
    expect(await store.exists('receipts/abc.pdf')).toBe(false);
    await expect(store.remove('receipts/abc.pdf')).resolves.toBeUndefined();
  });
});

/** Client S3 sans réseau : la signature d'URL est purement locale, les envois sont observés. */
function clientFactice(réponses: Record<string, unknown | Error> = {}) {
  const envois: { nom: string; input: Record<string, unknown> }[] = [];
  const client = new S3Client({
    endpoint: 'https://compte.r2.cloudflarestorage.com',
    region: 'auto',
    credentials: { accessKeyId: 'clé', secretAccessKey: 'secret' },
    forcePathStyle: true,
  });
  client.send = (async (commande: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const nom = commande.constructor.name;
    envois.push({ nom, input: commande.input });
    const réponse = réponses[nom];
    if (réponse instanceof Error) throw réponse;
    return réponse ?? {};
  }) as typeof client.send;
  return { client, envois };
}

describe('S3ObjectStore', () => {
  it('dépose l’objet avec son type MIME', async () => {
    const { client, envois } = clientFactice();
    await new S3ObjectStore(client, 'sharemate').put('receipts/abc.pdf', Buffer.from('x'), 'application/pdf');
    expect(envois[0]).toMatchObject({
      nom: 'PutObjectCommand',
      input: { Bucket: 'sharemate', Key: 'receipts/abc.pdf', ContentType: 'application/pdf' },
    });
  });

  it('signe une URL de durée bornée, qui porte le type et le nom à servir', async () => {
    const { client } = clientFactice();
    const url = new URL(
      await new S3ObjectStore(client, 'sharemate').signedUrl(
        'receipts/abc.pdf',
        'application/pdf',
        contentDisposition('recu.pdf', true),
        60,
      ),
    );
    expect(url.hostname).toBe('compte.r2.cloudflarestorage.com');
    expect(url.pathname).toContain('receipts/abc.pdf');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url.searchParams.get('response-content-disposition')).toContain('recu.pdf');
  });

  it('lit l’absence d’un objet comme une réponse, pas comme une panne', async () => {
    const absent = Object.assign(new Error('Not Found'), { name: 'NotFound' });
    expect(
      await new S3ObjectStore(clientFactice({ HeadObjectCommand: absent }).client, 'b').exists('receipts/a.pdf'),
    ).toBe(false);

    const absent404 = Object.assign(new Error('404'), { $metadata: { httpStatusCode: 404 } });
    expect(
      await new S3ObjectStore(clientFactice({ HeadObjectCommand: absent404 }).client, 'b').exists('receipts/a.pdf'),
    ).toBe(false);

    expect(await new S3ObjectStore(clientFactice().client, 'b').exists('receipts/a.pdf')).toBe(true);
  });

  // Une panne du bucket ne doit pas se déguiser en « justificatif introuvable » : l'exploitant
  // verrait un 404 là où son stockage est en rade.
  it('laisse remonter toute autre erreur du bucket', async () => {
    const panne = Object.assign(new Error('Service Unavailable'), { $metadata: { httpStatusCode: 503 } });
    await expect(
      new S3ObjectStore(clientFactice({ HeadObjectCommand: panne }).client, 'b').exists('receipts/a.pdf'),
    ).rejects.toThrow(/Service Unavailable/);
  });
});

describe('createS3ObjectStore', () => {
  const VARIABLES = {
    S3_BUCKET: 'sharemate',
    S3_ENDPOINT: 'https://compte.r2.cloudflarestorage.com',
    S3_ACCESS_KEY_ID: 'clé',
    S3_SECRET_ACCESS_KEY: 'secret',
  };

  it('décrit un bucket dès que ses quatre variables sont présentes', () => {
    expect(createS3ObjectStore(VARIABLES)).toBeInstanceOf(S3ObjectStore);
  });

  it('ne décrit rien si une seule manque', () => {
    for (const manquante of Object.keys(VARIABLES)) {
      expect(createS3ObjectStore({ ...VARIABLES, [manquante]: undefined })).toBeNull();
    }
  });
});

describe('MediaStorage', () => {
  function dépôt(legacy?: FileObjectStore) {
    const primaire = new FileObjectStore(path.join(répertoire, 'primaire'), 'documents/');
    return { primaire, media: new MediaStorage(primaire, { keyPrefix: 'documents/', contentTypes: TYPES }, legacy) };
  }

  it('nomme ses clés sous son préfixe, et une clé neuve à chaque dépôt', async () => {
    const { media } = dépôt();
    const clé = await media.save(Buffer.from('contenu'), '.PDF');
    expect(clé).toMatch(/^documents\/[0-9a-f-]{36}\.pdf$/);
    expect(await media.save(Buffer.from('contenu'), '.pdf')).not.toBe(clé);
  });

  it('refuse une extension hors de sa politique', async () => {
    const { media } = dépôt();
    expect(media.supports('.zip')).toBe(false);
    await expect(media.save(Buffer.from('x'), '.zip')).rejects.toThrow(/non gérée/);
  });

  it('sert un flux quand le magasin ne signe pas d’URL', async () => {
    const { media } = dépôt();
    const clé = await media.save(Buffer.from('le manuel'), '.pdf');
    const livraison = await media.open(clé, 'manuel.pdf');
    if (livraison?.kind !== 'stream') throw new Error('flux attendu');
    expect(livraison.contentType).toBe('application/pdf');
    expect(livraison.disposition).toMatch(/^inline; filename="manuel.pdf"/);
    expect(await lire(livraison.stream)).toBe('le manuel');
  });

  it('ne rend rien pour une clé absente ou d’extension inconnue', async () => {
    const { media } = dépôt();
    expect(await media.open('documents/00000000-0000-4000-8000-000000000000.pdf', 'x.pdf')).toBeNull();
    expect(await media.open('documents/abc.zip', 'x.zip')).toBeNull();
  });

  describe('bascule vers un nouveau magasin', () => {
    /** Un objet déposé avant la bascule dort dans l'ancien magasin, pas dans le nouveau. */
    async function aprèsBascule() {
      const ancien = new FileObjectStore(path.join(répertoire, 'ancien'), 'documents/');
      const clé = 'documents/11111111-1111-4111-8111-111111111111.pdf';
      await ancien.put(clé, Buffer.from('déposé avant'), 'application/pdf');
      return { clé, ...dépôt(ancien) };
    }

    it('lit encore ce que l’ancien magasin porte', async () => {
      const { media, clé } = await aprèsBascule();
      const livraison = await media.open(clé, 'ancien.pdf');
      if (livraison?.kind !== 'stream') throw new Error('flux attendu');
      expect(await lire(livraison.stream)).toBe('déposé avant');
    });

    it('écrit les nouveaux objets dans le magasin principal, et lui seul', async () => {
      const { media, primaire } = await aprèsBascule();
      const clé = await media.save(Buffer.from('déposé après'), '.pdf');
      expect(await primaire.exists(clé)).toBe(true);
      expect(fs.readdirSync(path.join(répertoire, 'ancien'))).toHaveLength(1);
    });

    // Après une bascule, on ne sait plus lequel des deux porte l'objet : la purge frappe les deux,
    // sinon un justificatif « supprimé » resterait lisible depuis le volume.
    it('purge les deux magasins', async () => {
      const { media, primaire, clé } = await aprèsBascule();
      const récent = await media.save(Buffer.from('déposé après'), '.pdf');

      await media.delete(clé);
      await media.delete(récent);

      expect(await media.open(clé, 'x.pdf')).toBeNull();
      expect(await primaire.exists(récent)).toBe(false);
    });
  });
});
