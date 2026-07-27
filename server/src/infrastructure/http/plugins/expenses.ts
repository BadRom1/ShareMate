import type { FastifyPluginAsync } from 'fastify';
import type { ExpenseCategory } from '../../../domain/expense/expense.js';
import type { ExpenseService, SplitInput } from '../../../application/expense-service.js';
import { expenseDto, reimbursementDto } from '../dto.js';
import '../session.js'; // augmentation de type : request.authMember

/** Dépenses, soldes et remboursements. */
export interface ExpenseRoutesOptions {
  expenseService: ExpenseService;
}

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
  }>('/api/expenses', async (request, reply) => {
    const expense = await expenseService.addExpense(request.body, request.authMember.id);
    return reply.status(201).send(expenseDto(expense));
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id/expenses', async (request) => {
    const list = await expenseService.listExpenses(request.params.id, request.authMember.id);
    return list.map(expenseDto);
  });

  app.delete<{ Params: { id: string } }>('/api/expenses/:id', async (request, reply) => {
    await expenseService.deleteExpense(request.params.id, request.authMember.id);
    return reply.status(204).send();
  });

  app.post<{
    Body: {
      equipmentId: string;
      fromMemberId: string;
      toMemberId: string;
      amountEuros: number;
      date: string;
      notes?: string | null;
    };
  }>('/api/reimbursements', async (request, reply) => {
    const reimbursement = await expenseService.recordReimbursement(request.body, request.authMember.id);
    return reply.status(201).send(reimbursementDto(reimbursement));
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id/reimbursements', async (request) => {
    const list = await expenseService.listReimbursements(request.params.id, request.authMember.id);
    return list.map(reimbursementDto);
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id/balances', async (request) => {
    const balances = await expenseService.equipmentBalances(request.params.id, request.authMember.id);
    return balances.map((b) => ({ memberId: b.memberId, balanceEuros: b.balanceCents / 100 }));
  });

  app.get<{ Params: { id: string } }>('/api/equipments/:id/settlement', async (request) => {
    const plan = await expenseService.settlementPlan(request.params.id, request.authMember.id);
    return plan.map((t) => ({
      fromMemberId: t.fromMemberId,
      toMemberId: t.toMemberId,
      amountEuros: t.amountCents / 100,
    }));
  });
};
