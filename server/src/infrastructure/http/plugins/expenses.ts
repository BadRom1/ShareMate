import type { FastifyPluginAsync } from 'fastify';
import path from 'node:path';
import { DomainError } from '../../../domain/shared/domain-error.js';
import { EXPENSE_CATEGORIES } from '../../../domain/expense/expense.js';
import type { ExpenseCategory } from '../../../domain/expense/expense.js';
import type { ExpenseService, SplitInput } from '../../../application/expense-service.js';
import { RECEIPT_MAX_BYTES } from '../../tech/receipt-storage.js';
import type { ReceiptStorage } from '../../tech/receipt-storage.js';
import { expenseDto, reimbursementDto } from '../dto.js';
import { enumField, jsonField, numberField, readUpload, requiredField } from '../multipart.js';
import { limit } from '../rate-limit.js';
import type { RateLimits } from '../rate-limit.js';
import { arrayOf, enumOf, id, idParams, isoDate, nullableText, number, object, receiptPath, text } from '../schema.js';
import '../session.js'; // augmentation de type : request.authMember

/** Dépenses, soldes et remboursements. */
export interface ExpenseRoutesOptions {
  expenseService: ExpenseService;
  /** Stockage des justificatifs. Absent, une dépense ne peut pas en porter. */
  receipts?: ReceiptStorage;
  rateLimits: RateLimits;
}

/**
 * Règle de répartition reçue en JSON dans un corps multipart, où le schéma JSON des autres routes
 * ne s'applique pas. Les trois formes sont reconstruites explicitement : un `type` inconnu doit
 * être refusé ici, le domaine ne saurait pas quoi en faire.
 */
function splitField(fields: Record<string, string>): SplitInput {
  const split = jsonField<{ type?: unknown; memberIds?: unknown; amountsEuros?: unknown }>(fields, 'split');
  switch (split.type) {
    case 'EQUAL': {
      if (split.memberIds === undefined) return { type: 'EQUAL' };
      if (!Array.isArray(split.memberIds) || split.memberIds.some((m) => typeof m !== 'string')) {
        throw new DomainError('Le partage égal attend une liste de membres.');
      }
      return { type: 'EQUAL', memberIds: split.memberIds as string[] };
    }
    case 'USAGE_PRORATED':
      return { type: 'USAGE_PRORATED' };
    case 'CUSTOM': {
      const amounts = split.amountsEuros;
      if (typeof amounts !== 'object' || amounts === null || Array.isArray(amounts)) {
        throw new DomainError('Le partage personnalisé attend un montant par membre.');
      }
      const amountsEuros: Record<string, number> = {};
      for (const [memberId, montant] of Object.entries(amounts)) {
        if (typeof montant !== 'number' || !Number.isFinite(montant)) {
          throw new DomainError(`La part de ${memberId} doit être un nombre.`);
        }
        amountsEuros[memberId] = montant;
      }
      return { type: 'CUSTOM', amountsEuros };
    }
    default:
      throw new DomainError('La répartition doit être EQUAL, USAGE_PRORATED ou CUSTOM.');
  }
}

/**
 * Règle de répartition : une seule des trois formes, chacune fermée. `oneOf` plutôt qu'un objet
 * à champs facultatifs, pour qu'un `amountsEuros` sur un partage EQUAL soit refusé et non ignoré.
 */
const SPLIT = {
  oneOf: [
    object({ type: enumOf(['EQUAL']), memberIds: arrayOf(id, 50) }, ['type']),
    object({ type: enumOf(['USAGE_PRORATED']) }, ['type']),
    object(
      { type: enumOf(['CUSTOM']), amountsEuros: { type: 'object', maxProperties: 50, additionalProperties: number() } },
      ['type', 'amountsEuros'],
    ),
  ],
};

export const expenseRoutes: FastifyPluginAsync<ExpenseRoutesOptions> = async (
  app,
  { expenseService, receipts, rateLimits },
) => {
  app.post<{
    Body: {
      equipmentId: string;
      label: string;
      amountEuros: number;
      payerId: string;
      date: string;
      category: ExpenseCategory;
      split: SplitInput;
      receiptPath?: string | null;
    };
  }>(
    '/api/expenses',
    {
      schema: {
        body: object(
          {
            equipmentId: id,
            label: text(200),
            amountEuros: number(),
            payerId: id,
            date: isoDate,
            category: enumOf(EXPENSE_CATEGORIES),
            split: SPLIT,
            receiptPath,
          },
          ['equipmentId', 'label', 'amountEuros', 'payerId', 'date', 'category', 'split'],
        ),
      },
    },
    async (request, reply) => {
      const expense = await expenseService.addExpense(request.body, request.authMember.id);
      return reply.status(201).send(expenseDto(expense));
    },
  );

  /**
   * Dépense accompagnée de son justificatif, en une seule requête plutôt qu'un téléversement suivi
   * d'un enregistrement : le fichier n'existe que si la dépense existe. Déposé d'abord puis rattaché
   * ensuite, il restait dans le bucket dès que la dépense était refusée — un formulaire abandonné
   * suffisait — et plus rien ne le nommait, donc plus rien ne pouvait le purger.
   */
  if (receipts) {
    app.post(
      '/api/expenses/file',
      { config: { rateLimit: limit(rateLimits.sensitive), maxFileBytes: RECEIPT_MAX_BYTES } },
      async (request, reply) => {
        const { fields, file } = await readUpload(request, RECEIPT_MAX_BYTES);
        if (!file) {
          return reply.status(400).send({ error: 'Aucun fichier reçu.' });
        }
        const extension = path.extname(file.filename).toLowerCase();
        if (!receipts.supports(extension)) {
          return reply.status(400).send({ error: 'Format accepté : image (png, jpg, webp) ou PDF.' });
        }
        const equipmentId = requiredField(fields, 'equipmentId');
        // Cercle d'abord : refuser après l'écriture laisserait un fichier orphelin dans le bucket.
        await expenseService.assertCanAttachReceipt(equipmentId, request.authMember.id);

        const storedPath = await receipts.save(file.content, extension);
        try {
          const expense = await expenseService.addExpense(
            {
              equipmentId,
              label: requiredField(fields, 'label'),
              amountEuros: numberField(fields, 'amountEuros'),
              payerId: requiredField(fields, 'payerId'),
              date: requiredField(fields, 'date'),
              category: enumField(fields, 'category', EXPENSE_CATEGORIES),
              split: splitField(fields),
              receiptPath: storedPath,
            },
            request.authMember.id,
          );
          return reply.status(201).send(expenseDto(expense));
        } catch (error) {
          // Le fichier vient d'être écrit et rien ne le nommera : on le retire avant de propager le refus.
          await receipts.delete(storedPath);
          throw error;
        }
      },
    );
  }

  app.get<{ Params: { id: string } }>(
    '/api/equipments/:id/expenses',
    { schema: { params: idParams } },
    async (request) => {
      const list = await expenseService.listExpenses(request.params.id, request.authMember.id);
      return list.map(expenseDto);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/expenses/:id',
    { schema: { params: idParams } },
    async (request, reply) => {
      await expenseService.deleteExpense(request.params.id, request.authMember.id);
      return reply.status(204).send();
    },
  );

  app.post<{
    Body: {
      equipmentId: string;
      fromMemberId: string;
      toMemberId: string;
      amountEuros: number;
      date: string;
      notes?: string | null;
    };
  }>(
    '/api/reimbursements',
    {
      schema: {
        body: object(
          {
            equipmentId: id,
            fromMemberId: id,
            toMemberId: id,
            amountEuros: number(),
            date: isoDate,
            notes: nullableText(2000),
          },
          ['equipmentId', 'fromMemberId', 'toMemberId', 'amountEuros', 'date'],
        ),
      },
    },
    async (request, reply) => {
      const reimbursement = await expenseService.recordReimbursement(request.body, request.authMember.id);
      return reply.status(201).send(reimbursementDto(reimbursement));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/equipments/:id/reimbursements',
    { schema: { params: idParams } },
    async (request) => {
      const list = await expenseService.listReimbursements(request.params.id, request.authMember.id);
      return list.map(reimbursementDto);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/equipments/:id/balances',
    { schema: { params: idParams } },
    async (request) => {
      const balances = await expenseService.equipmentBalances(request.params.id, request.authMember.id);
      return balances.map((b) => ({ memberId: b.memberId, balanceEuros: b.balanceCents / 100 }));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/equipments/:id/settlement',
    { schema: { params: idParams } },
    async (request) => {
      const plan = await expenseService.settlementPlan(request.params.id, request.authMember.id);
      return plan.map((t) => ({
        fromMemberId: t.fromMemberId,
        toMemberId: t.toMemberId,
        amountEuros: t.amountCents / 100,
      }));
    },
  );
};
