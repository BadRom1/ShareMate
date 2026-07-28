import type { FastifyPluginAsync } from 'fastify';
import { EXPENSE_CATEGORIES } from '../../../domain/expense/expense.js';
import type { ExpenseCategory } from '../../../domain/expense/expense.js';
import type { ExpenseService, SplitInput } from '../../../application/expense-service.js';
import { expenseDto, reimbursementDto } from '../dto.js';
import { arrayOf, enumOf, id, idParams, isoDate, nullableText, number, object, receiptPath, text } from '../schema.js';
import '../session.js'; // augmentation de type : request.authMember

/** Dépenses, soldes et remboursements. */
export interface ExpenseRoutesOptions {
  expenseService: ExpenseService;
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

export const expenseRoutes: FastifyPluginAsync<ExpenseRoutesOptions> = async (app, { expenseService }) => {
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
