import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { ReceiptStorage } from '../../application/ports.js';

/** Préfixe public des justificatifs, seule forme qui circule hors de l'infrastructure. */
export const RECEIPT_PREFIX = '/uploads/';

/** Extensions acceptées, et type MIME servi en retour — jamais celui annoncé par le client. */
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

/** Nom de fichier tel que produit par `save` : UUID v4 + extension acceptée. */
const RECEIPT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|webp|pdf)$/;

/** Justificatif prêt à être servi. */
export interface StoredReceipt {
  stream: Readable;
  contentType: string;
  size: number;
}

/**
 * Justificatifs rangés à plat dans un répertoire du disque. Seul module à connaître ce répertoire :
 * un chemin de fichier n'est construit qu'ici, et uniquement à partir d'un nom que `save` a pu
 * produire. Toute autre forme est écartée sans toucher au disque, ce qui ferme la traversée de
 * répertoire par construction plutôt que par filtrage.
 */
export class FileSystemReceiptStorage implements ReceiptStorage {
  constructor(private readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true });
  }

  /** Extension (avec le point, en minuscules) acceptée au téléversement. */
  static supports(extension: string): boolean {
    return extension in CONTENT_TYPES;
  }

  private filePath(receiptPath: string): string | null {
    const name = receiptPath.startsWith(RECEIPT_PREFIX) ? receiptPath.slice(RECEIPT_PREFIX.length) : '';
    return RECEIPT_NAME.test(name) ? path.join(this.directory, name) : null;
  }

  /** Écrit le fichier sous un nom neuf et renvoie son chemin public. */
  async save(content: Buffer, extension: string): Promise<string> {
    if (!FileSystemReceiptStorage.supports(extension)) {
      throw new Error(`Extension de justificatif non gérée : ${extension}`);
    }
    const receiptPath = `${RECEIPT_PREFIX}${crypto.randomUUID()}${extension}`;
    await fs.promises.writeFile(this.filePath(receiptPath)!, content);
    return receiptPath;
  }

  /** Justificatif ouvert en lecture, ou `null` si rien de tel n'est stocké ici. */
  async open(receiptPath: string): Promise<StoredReceipt | null> {
    const file = this.filePath(receiptPath);
    if (!file) return null;
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) return null;
    return { stream: fs.createReadStream(file), contentType: CONTENT_TYPES[path.extname(file)]!, size: stat.size };
  }

  async delete(receiptPath: string): Promise<void> {
    const file = this.filePath(receiptPath);
    if (!file) return;
    await fs.promises.rm(file, { force: true });
  }
}
