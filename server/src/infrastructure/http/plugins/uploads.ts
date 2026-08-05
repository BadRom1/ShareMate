import type { FastifyPluginAsync } from 'fastify';
import path from 'node:path';
import { NotFoundError } from '../../../domain/shared/domain-error.js';
import { receiptNotFound } from '../../../application/receipt-access.js';
import type { ExpenseService } from '../../../application/expense-service.js';
import { RECEIPT_PREFIX } from '../../tech/receipt-storage.js';
import type { ReceiptStorage } from '../../tech/receipt-storage.js';
import { limit } from '../rate-limit.js';
import type { RateLimits } from '../rate-limit.js';
import { receiptNameParams } from '../schema.js';
import '../session.js'; // augmentation de type : request.authMember

/** Poids maximal d'un justificatif de dépense. */
const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

export interface UploadRoutesOptions {
  /** Stockage des justificatifs (bucket S3/R2, ou répertoire de dépôt). */
  storage: ReceiptStorage;
  /** Porte la règle d'accès : un justificatif se lit par la dépense qui le porte. */
  expenseService: ExpenseService;
  rateLimits: RateLimits;
}

export const uploadRoutes: FastifyPluginAsync<UploadRoutesOptions> = async (
  app,
  { storage, expenseService, rateLimits },
) => {
  // 10 Mo par fichier : plafond serré, sinon le disque se remplit à volonté. Il est posé ici et
  // non à l'enregistrement du greffon multipart, désormais transverse : un justificatif et un
  // document du dossier n'ont pas le même plafond.
  app.post('/api/uploads/receipts', { config: { rateLimit: limit(rateLimits.sensitive) } }, async (request, reply) => {
    const file = await request.file({ limits: { fileSize: RECEIPT_MAX_BYTES } });
    if (!file) {
      return reply.status(400).send({ error: 'Aucun fichier reçu.' });
    }
    const extension = path.extname(file.filename).toLowerCase();
    if (!storage.supports(extension)) {
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
      // Jamais de copie durable côté client : la réponse dépend de droits qui peuvent changer, le
      // fichier survivrait à une déconnexion sur l'appareil, et l'URL signée d'une redirection
      // expire — la rejouer depuis un cache ne donnerait qu'un refus.
      reply.header('Cache-Control', 'private, no-store');
      if (receipt.kind === 'redirect') {
        return reply.redirect(receipt.url, 302);
      }
      return reply.header('Content-Length', receipt.size).type(receipt.contentType).send(receipt.stream);
    },
  );
};
