import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Magasin d'objets brut : des clés, des octets, rien d'autre. Il ignore ce qu'il range — c'est la
 * couche au-dessus (`MediaStorage`) qui sait ce qu'est un justificatif ou un document, quelles
 * extensions elle accepte et sous quel préfixe elle nomme ses clés.
 *
 * Deux implémentations : un bucket compatible S3 (Cloudflare R2 en production, S3 ailleurs — même
 * protocole, même SDK, seul l'endpoint change) et un répertoire du disque, qui sert de repli en
 * développement et de lecture des objets déposés avant la bascule vers le bucket.
 */
export interface ObjectStore {
  /** L'objet est-il ici ? Question posée avant toute lecture : un magasin peut en cacher un autre. */
  exists(key: string): Promise<boolean>;
  put(key: string, content: Buffer, contentType: string): Promise<void>;
  /**
   * URL signée temporaire vers l'objet, ou `null` si ce magasin n'en produit pas — le disque local
   * n'est joignable que par l'API, qui relaie alors le flux elle-même.
   */
  signedUrl(key: string, contentType: string, disposition: string, ttlSeconds: number): Promise<string | null>;
  read(key: string): Promise<{ stream: Readable; size: number } | null>;
  remove(key: string): Promise<void>;
}

/**
 * Nom d'un objet sous son préfixe : ni séparateur, ni chemin relatif. Les appelants valident déjà
 * la forme exacte qu'ils produisent (UUID + extension) ; cette borne-ci est la seconde, celle qui
 * garantit qu'aucune clé ne peut désigner un fichier hors du répertoire, quelle que soit l'erreur
 * commise au-dessus.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Objets rangés à plat dans un répertoire du disque, le préfixe de leur clé retiré. */
export class FileObjectStore implements ObjectStore {
  constructor(
    private readonly directory: string,
    private readonly keyPrefix: string,
  ) {
    fs.mkdirSync(directory, { recursive: true });
  }

  /** Chemin du fichier, ou `null` si la clé ne peut désigner aucun objet de ce magasin. */
  private filePath(key: string): string | null {
    if (!key.startsWith(this.keyPrefix)) return null;
    const name = key.slice(this.keyPrefix.length);
    if (!SAFE_NAME.test(name) || name.includes('..')) return null;
    return path.join(this.directory, name);
  }

  async exists(key: string): Promise<boolean> {
    const file = this.filePath(key);
    if (!file) return false;
    return (await fs.promises.stat(file).catch(() => null))?.isFile() ?? false;
  }

  async put(key: string, content: Buffer, _contentType: string): Promise<void> {
    const file = this.filePath(key);
    if (!file) throw new Error(`Clé d’objet invalide : ${key}`);
    await fs.promises.writeFile(file, content);
  }

  /** Le disque n'est pas joignable de l'extérieur : il n'y a pas d'URL à signer. */
  async signedUrl(): Promise<string | null> {
    return null;
  }

  async read(key: string): Promise<{ stream: Readable; size: number } | null> {
    const file = this.filePath(key);
    if (!file) return null;
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) return null;
    return { stream: fs.createReadStream(file), size: stat.size };
  }

  async remove(key: string): Promise<void> {
    const file = this.filePath(key);
    if (!file) return;
    await fs.promises.rm(file, { force: true });
  }
}

/** Objets rangés dans un bucket compatible S3. Le bucket reste privé : rien n'y est lisible sans signature. */
export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      // Une clé absente est une réponse, pas une panne ; tout le reste doit remonter.
      if ((error as { name?: string }).name === 'NotFound') return false;
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
      throw error;
    }
  }

  async put(key: string, content: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: content, ContentType: contentType }),
    );
  }

  async signedUrl(key: string, contentType: string, disposition: string, ttlSeconds: number): Promise<string> {
    // Le type et le nom d'origine voyagent dans l'URL : le bucket ne connaît que la clé, un UUID
    // illisible sur le poste du membre.
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: contentType,
        ResponseContentDisposition: disposition,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  /** Jamais appelé en production — `signedUrl` fait le travail — mais le port doit être complet. */
  async read(): Promise<null> {
    return null;
  }

  async remove(key: string): Promise<void> {
    // S3 rend un succès sur une clé absente : la purge est idempotente sans effort.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/**
 * Bucket S3/R2 décrit par l'environnement, ou `null` si l'une de ses quatre variables manque.
 * L'absence n'est pas un mode dégradé caché : c'est ce qui permet aux tests et au développement de
 * tourner sur le disque, exactement comme le push tourne sans clés VAPID.
 */
export function createS3ObjectStore(env: NodeJS.ProcessEnv): S3ObjectStore | null {
  const { S3_BUCKET: bucket, S3_ENDPOINT: endpoint, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (!bucket || !endpoint || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) return null;
  return new S3ObjectStore(
    new S3Client({
      endpoint,
      // R2 ignore la région mais le SDK en exige une ; `auto` est la valeur que Cloudflare documente.
      region: env.S3_REGION ?? 'auto',
      credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
      // Les endpoints personnalisés ne servent pas tous le style « bucket dans le sous-domaine ».
      forcePathStyle: true,
    }),
    bucket,
  );
}

/** Extension acceptée, et ce que le navigateur doit en faire. */
export interface MediaType {
  type: string;
  /** `true` si un navigateur sait l'afficher : proposer un .docx dans un onglet ne donne rien de lisible. */
  inline: boolean;
}

export interface MediaPolicy {
  /** Préfixe des clés produites par ce dépôt (`receipts/`, `documents/`). */
  keyPrefix: string;
  contentTypes: Record<string, MediaType>;
  /** Durée de vie de l'URL signée. Courte : elle circule, et les droits peuvent changer. */
  signedUrlTtlSeconds?: number;
}

/**
 * Comment servir le contenu d'un objet. Chaque magasin répond dans ses termes : le bucket délivre
 * une URL signée vers laquelle rediriger, le disque rend un flux que l'API relaie. L'adapter HTTP
 * n'a donc aucune branche « quel stockage ? ».
 */
export type MediaDelivery =
  | { kind: 'redirect'; url: string }
  | { kind: 'stream'; stream: Readable; contentType: string; size: number; disposition: string };

/**
 * En-tête `Content-Disposition`. Le nom d'origine est rendu deux fois : en ASCII pour les clients
 * anciens, et en UTF-8 percent-encodé (RFC 5987) pour les autres — sans quoi « Manuel d'été.pdf »
 * arrive sur le poste sous un nom mutilé. Guillemet et contre-oblique sont neutralisés : ils
 * refermeraient le paramètre et laisseraient le reste du nom passer pour des directives d'en-tête.
 */
export function contentDisposition(fileName: string, inline: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Dépôt typé au-dessus d'un magasin d'objets : il sait quelles extensions il accepte, sous quel
 * préfixe il nomme ses clés, et quel type MIME servir en retour — jamais celui annoncé par le
 * client, qui déciderait sinon de ce que le navigateur exécute.
 *
 * `legacy` est le magasin des objets déposés **avant** la bascule vers le bucket : la lecture s'y
 * rabat quand le bucket ne connaît pas la clé, et la purge frappe les deux. Une instance sans
 * bucket n'en a pas besoin, une instance migrée s'en passera le jour où le volume disparaîtra.
 */
export class MediaStorage {
  private readonly ttl: number;
  private readonly keyShape: RegExp;

  constructor(
    private readonly primary: ObjectStore,
    private readonly policy: MediaPolicy,
    private readonly legacy?: ObjectStore,
  ) {
    this.ttl = policy.signedUrlTtlSeconds ?? 300;
    // Forme exacte de ce que `save` produit. Une clé qui ne la respecte pas n'atteint aucun
    // magasin : la traversée de répertoire est fermée par construction, pas par filtrage.
    this.keyShape = new RegExp(
      `^${policy.keyPrefix}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` +
        `\\.(${Object.keys(policy.contentTypes)
          .map((extension) => extension.slice(1))
          .join('|')})$`,
    );
  }

  /** La clé a-t-elle la forme que ce dépôt produit ? */
  knows(key: string): boolean {
    return this.keyShape.test(key);
  }

  /** Extension (avec le point) acceptée au dépôt ; la casse n'entre pas en compte. */
  supports(extension: string): boolean {
    return extension.toLowerCase() in this.policy.contentTypes;
  }

  /** Type MIME servi pour cette extension. */
  contentType(extension: string): string {
    return this.policy.contentTypes[extension.toLowerCase()]?.type ?? 'application/octet-stream';
  }

  /** Extensions acceptées, pour les messages d'erreur et la boîte de dialogue du navigateur. */
  extensions(): string[] {
    return Object.keys(this.policy.contentTypes);
  }

  /** Clé neuve, telle que ce dépôt les produit : préfixe + UUID v4 + extension. */
  newKey(extension: string): string {
    return `${this.policy.keyPrefix}${crypto.randomUUID()}${extension.toLowerCase()}`;
  }

  /** Écrit l'objet sous une clé neuve et la renvoie. */
  async save(content: Buffer, extension: string): Promise<string> {
    if (!this.supports(extension)) {
      throw new Error(`Extension non gérée : ${extension}`);
    }
    const key = this.newKey(extension);
    await this.primary.put(key, content, this.contentType(extension));
    return key;
  }

  /** Contenu prêt à être servi, ou `null` si aucun magasin ne connaît cette clé. */
  async open(key: string, fileName: string): Promise<MediaDelivery | null> {
    if (!this.knows(key)) return null;
    const extension = path.extname(key).toLowerCase();
    const contentType = this.contentType(extension);
    const disposition = contentDisposition(fileName, this.policy.contentTypes[extension]!.inline);

    for (const store of this.stores()) {
      if (!(await store.exists(key))) continue;
      const url = await store.signedUrl(key, contentType, disposition, this.ttl);
      if (url) return { kind: 'redirect', url };
      const bytes = await store.read(key);
      if (bytes) return { kind: 'stream', ...bytes, contentType, disposition };
    }
    return null;
  }

  /** Retire l'objet des deux magasins : après une bascule, on ne sait plus lequel le porte. */
  async delete(key: string): Promise<void> {
    if (!this.knows(key)) return;
    for (const store of this.stores()) {
      await store.remove(key);
    }
  }

  private stores(): ObjectStore[] {
    return this.legacy ? [this.primary, this.legacy] : [this.primary];
  }
}
