import type { FastifyPluginAsync } from 'fastify';
import multipart from '@fastify/multipart';
import path from 'node:path';
import { NotFoundError } from '../../../domain/shared/domain-error.js';
import { receiptNotFound } from '../../../application/receipt-access.js';
import type { ExpenseService } from '../../../application/expense-service.js';
import { FileSystemReceiptStorage, RECEIPT_PREFIX } from '../../tech/receipt-storage.js';
import { limit } from '../rate-limit.js';
import type { RateLimits } from '../rate-limit.js';
import { receiptNameParams } from '../schema.js';
import '../session.js'; // augmentation de type : request.authMember

export interface UploadRoutesOptions {
  /** Stockage des justificatifs (répertoire de dépôt). */
  storage: FileSystemReceiptStorage;
  /** Porte la règle d'accès : un justificatif se lit par la dépense qui le porte. */
  expenseService: ExpenseService;
  rateLimits: RateLimits;
}

export const uploadRoutes: FastifyPluginAsync<UploadRoutesOptions> = async (
  app,
  { storage, expenseService, rateLimits },
) => {
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  // 10 Mo par fichier : plafond serré, sinon le disque se remplit à volonté.
  app.post('/api/uploads/receipts', { config: { rateLimit: limit(rateLimits.sensitive) } }, async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.status(400).send({ error: 'Aucun fichier reçu.' });
    }
    const extension = path.extname(file.filename).toLowerCase();
    if (!FileSystemReceiptStorage.supports(extension)) {
      return reply.status(400).send({ error: 'Format accepté : image (png, jpg, webp) ou PDF.' });
    }
    return reply.status(201).send({ path: await storage.save(await file.toBuffer(), extension) });
  });

  /**
   * Lecture d'un justificatif. Le nom du fichier est un UUID, mais il circule (capture d'écran,
   * lien recopié, cache d'un appareil) : l'accès est décidé par le cercle de la dépense qui le
   * porte, comme pour toute autre donnée. Un fichier orphelin ou hors cercle donne exactement la
   * même réponse qu'un fichier inexistant.
   */
  app.get<{ Params: { name: string } }>(
    '/uploads/:name',
    { schema: { params: receiptNameParams } },
    async (request, reply) => {
      const receiptPath = `${RECEIPT_PREFIX}${request.params.name}`;
      await expenseService.receiptOwner(receiptPath, request.authMember.id);
      const receipt = await storage.open(receiptPath);
      if (!receipt) {
        throw new NotFoundError(receiptNotFound(receiptPath));
      }
      // Jamais de copie durable côté client : la réponse dépend de droits qui peuvent changer,
      // et le fichier survivrait à une déconnexion sur l'appareil.
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('Content-Length', receipt.size)
        .type(receipt.contentType)
        .send(receipt.stream);
    },
  );
};
