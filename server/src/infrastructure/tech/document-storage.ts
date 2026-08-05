import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectStorage } from '../../application/ports.js';

/** Préfixe des clés d'objets, seule forme qui circule hors de l'infrastructure. */
export const DOCUMENT_PREFIX = 'documents/';

/**
 * Extensions acceptées au dépôt, et type MIME servi en retour — jamais celui annoncé par le
 * client. `inline` distingue ce qu'un navigateur sait afficher de ce qu'il doit télécharger :
 * proposer l'ouverture d'un .docx dans un onglet n'aboutit qu'à une page illisible.
 *
 * Ni exécutables, ni archives, ni HTML : le contenu d'un objet est servi depuis un domaine
 * distinct du nôtre (bucket), où une page fabriquée s'exécuterait dans son propre contexte.
 */
const CONTENT_TYPES: Record<string, { type: string; inline: boolean }> = {
  '.pdf': { type: 'application/pdf', inline: true },
  '.png': { type: 'image/png', inline: true },
  '.jpg': { type: 'image/jpeg', inline: true },
  '.jpeg': { type: 'image/jpeg', inline: true },
  '.webp': { type: 'image/webp', inline: true },
  '.gif': { type: 'image/gif', inline: true },
  '.txt': { type: 'text/plain; charset=utf-8', inline: false },
  '.csv': { type: 'text/csv; charset=utf-8', inline: false },
  '.doc': { type: 'application/msword', inline: false },
  '.docx': { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', inline: false },
  '.xls': { type: 'application/vnd.ms-excel', inline: false },
  '.xlsx': { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', inline: false },
  '.ppt': { type: 'application/vnd.ms-powerpoint', inline: false },
  '.pptx': { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', inline: false },
  '.odt': { type: 'application/vnd.oasis.opendocument.text', inline: false },
  '.ods': { type: 'application/vnd.oasis.opendocument.spreadsheet', inline: false },
  '.odp': { type: 'application/vnd.oasis.opendocument.presentation', inline: false },
};

/** Nom d'objet tel que produit par `save` : UUID v4 + extension acceptée. */
const DOCUMENT_KEY = new RegExp(
  `^${DOCUMENT_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` +
    `\\.(${Object.keys(CONTENT_TYPES)
      .map((extension) => extension.slice(1))
      .join('|')})$`,
);

/** Extension (avec le point, en minuscules) acceptée au dépôt. */
export function supportsDocumentExtension(extension: string): boolean {
  return extension.toLowerCase() in CONTENT_TYPES;
}

/** Type MIME servi pour cette extension. */
export function documentContentType(extension: string): string {
  return CONTENT_TYPES[extension.toLowerCase()]?.type ?? 'application/octet-stream';
}

/** Extensions acceptées, pour les messages d'erreur et la boîte de dialogue du navigateur. */
export function acceptedDocumentExtensions(): string[] {
  return Object.keys(CONTENT_TYPES);
}

/**
 * En-tête `Content-Disposition`. Le nom d'origine est rendu deux fois : en ASCII pour les clients
 * anciens, et en UTF-8 percent-encodé (RFC 5987) pour les autres — sans quoi « Manuel d'été.pdf »
 * arrive sur le poste sous un nom mutilé, voire coupe l'en-tête en deux au guillemet.
 */
export function documentDisposition(storageKey: string, fileName: string): string {
  const inline = CONTENT_TYPES[path.extname(storageKey).toLowerCase()]?.inline ?? false;
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Comment servir le contenu d'un document. Chaque stockage répond dans ses termes : le bucket
 * délivre une URL signée à durée de vie courte vers laquelle rediriger, le disque local rend un
 * flux que l'API relaie elle-même. L'adapter HTTP n'a donc aucune branche « quel stockage ? ».
 */
export type DocumentDelivery =
  | { kind: 'redirect'; url: string }
  | { kind: 'stream'; stream: Readable; contentType: string; size: number; disposition: string };

export interface DocumentStorage extends ObjectStorage {
  /** Écrit l'objet sous une clé neuve et la renvoie. */
  save(content: Buffer, extension: string): Promise<string>;
  /** Contenu prêt à être servi, ou `null` si rien de tel n'est stocké ici. */
  open(storageKey: string, fileName: string): Promise<DocumentDelivery | null>;
}

function newKey(extension: string): string {
  return `${DOCUMENT_PREFIX}${crypto.randomUUID()}${extension.toLowerCase()}`;
}

function assertSupported(extension: string): void {
  if (!supportsDocumentExtension(extension)) {
    throw new Error(`Extension de document non gérée : ${extension}`);
  }
}

/**
 * Documents rangés à plat dans un répertoire du disque — repli de développement, et déploiement
 * sans bucket. Seul ce module connaît ce répertoire : un chemin de fichier n'est construit qu'ici,
 * et uniquement à partir d'une clé que `save` a pu produire. Toute autre forme est écartée sans
 * toucher au disque, ce qui ferme la traversée de répertoire par construction plutôt que par
 * filtrage.
 */
export class FileSystemDocumentStorage implements DocumentStorage {
  constructor(private readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true });
  }

  private filePath(storageKey: string): string | null {
    return DOCUMENT_KEY.test(storageKey) ? path.join(this.directory, storageKey.slice(DOCUMENT_PREFIX.length)) : null;
  }

  async save(content: Buffer, extension: string): Promise<string> {
    assertSupported(extension);
    const storageKey = newKey(extension);
    await fs.promises.writeFile(this.filePath(storageKey)!, content);
    return storageKey;
  }

  async open(storageKey: string, fileName: string): Promise<DocumentDelivery | null> {
    const file = this.filePath(storageKey);
    if (!file) return null;
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) return null;
    return {
      kind: 'stream',
      stream: fs.createReadStream(file),
      contentType: documentContentType(path.extname(file)),
      size: stat.size,
      disposition: documentDisposition(storageKey, fileName),
    };
  }

  async delete(storageKey: string): Promise<void> {
    const file = this.filePath(storageKey);
    if (!file) return;
    await fs.promises.rm(file, { force: true });
  }
}

export interface S3DocumentStorageOptions {
  bucket: string;
  /** Durée de vie de l'URL signée. Courte : elle circule, et les droits peuvent changer. */
  signedUrlTtlSeconds?: number;
}

/**
 * Documents rangés dans un bucket compatible S3 (Cloudflare R2 en production, S3 ailleurs — même
 * protocole, même SDK, seul l'endpoint change).
 *
 * Le bucket n'est jamais public : le membre ne reçoit qu'une URL signée valable quelques minutes,
 * émise après vérification du cercle par la couche application. Recopiée, elle devient inerte —
 * ce qu'une URL de bucket ouvert ne fait jamais.
 */
export class S3DocumentStorage implements DocumentStorage {
  private readonly ttl: number;

  constructor(
    private readonly client: S3Client,
    private readonly options: S3DocumentStorageOptions,
  ) {
    this.ttl = options.signedUrlTtlSeconds ?? 300;
  }

  async save(content: Buffer, extension: string): Promise<string> {
    assertSupported(extension);
    const storageKey = newKey(extension);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: storageKey,
        Body: content,
        ContentType: documentContentType(extension),
      }),
    );
    return storageKey;
  }

  async open(storageKey: string, fileName: string): Promise<DocumentDelivery | null> {
    if (!DOCUMENT_KEY.test(storageKey)) return null;
    // Le nom d'origine et la disposition sont portés par l'URL signée : c'est le bucket qui
    // servira l'objet, et il ne connaît que la clé — un UUID, illisible sur le poste du membre.
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: storageKey,
        ResponseContentType: documentContentType(path.extname(storageKey)),
        ResponseContentDisposition: documentDisposition(storageKey, fileName),
      }),
      { expiresIn: this.ttl },
    );
    return { kind: 'redirect', url };
  }

  async delete(storageKey: string): Promise<void> {
    if (!DOCUMENT_KEY.test(storageKey)) return;
    // S3 rend un succès sur une clé absente : la purge est idempotente sans effort.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: storageKey }));
  }
}

/**
 * Stockage des documents choisi par l'environnement : bucket S3/R2 dès que ses quatre variables
 * sont présentes, sinon le disque local. Le repli n'est pas un mode dégradé caché — c'est ce qui
 * permet aux tests et au développement de tourner sans bucket, exactement comme le push tourne
 * sans clés VAPID.
 */
export function createDocumentStorage(
  env: NodeJS.ProcessEnv,
  fallbackDirectory: string | null,
): DocumentStorage | null {
  const bucket = env.S3_BUCKET;
  const endpoint = env.S3_ENDPOINT;
  const accessKeyId = env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
  if (bucket && endpoint && accessKeyId && secretAccessKey) {
    return new S3DocumentStorage(
      new S3Client({
        endpoint,
        // R2 ignore la région mais le SDK en exige une ; `auto` est la valeur que Cloudflare documente.
        region: env.S3_REGION ?? 'auto',
        credentials: { accessKeyId, secretAccessKey },
        // Les endpoints personnalisés ne servent pas tous le style « bucket dans le sous-domaine ».
        forcePathStyle: true,
      }),
      { bucket },
    );
  }
  return fallbackDirectory ? new FileSystemDocumentStorage(fallbackDirectory) : null;
}
