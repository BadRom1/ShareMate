import { beforeEach, describe, expect, it } from 'vitest';
import { makeFixture } from './testing/fixture.js';
import { ExpenseService } from './expense-service.js';
import { ForbiddenError } from '../domain/shared/domain-error.js';
import { ReservationService } from './reservation-service.js';

let f: Awaited<ReturnType<typeof makeFixture>>;
let service: ExpenseService;
let reservationService: ReservationService;

beforeEach(async () => {
  f = await makeFixture();
  service = new ExpenseService(f.expenses, f.reimbursements, f.equipments, f.reservations, f.idGenerator);
  reservationService = new ReservationService(f.reservations, f.equipments, f.idGenerator, f.clock);
});

// Le cercle de e1 est m1/m2 : les dépenses se répartissent entre eux.
const base = {
  equipmentId: 'e1',
  label: 'Plein gasoil',
  amountEuros: 90,
  payerId: 'm1',
  date: '2026-07-01',
  category: 'FUEL' as const,
};

describe('ExpenseService — saisie', () => {
  it('crée une dépense en parts égales sur tout le cercle par défaut', async () => {
    const x = await service.addExpense({ ...base, split: { type: 'EQUAL' } }, 'm1');
    const shares = x.shares();
    expect([...shares.keys()].sort()).toEqual(['m1', 'm2']);
    expect(shares.get('m1')!.cents).toBe(4500);
  });

  it('crée une dépense en parts égales sur un sous-ensemble du cercle', async () => {
    const x = await service.addExpense({ ...base, split: { type: 'EQUAL', memberIds: ['m1'] } }, 'm1');
    expect([...x.shares().keys()]).toEqual(['m1']);
  });

  it('refuse un équipement inexistant', async () => {
    await expect(service.addExpense({ ...base, equipmentId: 'nope', split: { type: 'EQUAL' } }, 'm1')).rejects.toThrow(
      /introuvable/i,
    );
  });

  it('refuse un payeur hors du cercle', async () => {
    await expect(service.addExpense({ ...base, payerId: 'm3', split: { type: 'EQUAL' } }, 'm1')).rejects.toThrow(
      /cercle/i,
    );
  });

  it('refuse une répartition incluant un membre hors du cercle', async () => {
    await expect(
      service.addExpense({ ...base, split: { type: 'EQUAL', memberIds: ['m1', 'm3'] } }, 'm1'),
    ).rejects.toThrow(/cercle/i);
  });

  it('répartition custom en euros', async () => {
    const x = await service.addExpense(
      {
        ...base,
        amountEuros: 100,
        split: { type: 'CUSTOM', amountsEuros: { m1: 70, m2: 30 } },
      },
      'm1',
    );
    expect(x.shares().get('m1')!.cents).toBe(7000);
  });

  it("prorata du temps d'usage : poids issus des réservations de l'équipement", async () => {
    // m1 a réservé 6 h, m2 a réservé 2 h → m1 paie 3/4, m2 1/4
    await reservationService.reserve({
      equipmentId: 'e1',
      memberId: 'm1',
      start: '2026-06-01T08:00:00Z',
      end: '2026-06-01T14:00:00Z',
    });
    await reservationService.reserve({
      equipmentId: 'e1',
      memberId: 'm2',
      start: '2026-06-02T08:00:00Z',
      end: '2026-06-02T10:00:00Z',
    });
    const x = await service.addExpense({ ...base, amountEuros: 100, split: { type: 'USAGE_PRORATED' } }, 'm1');
    expect(x.shares().get('m1')!.cents).toBe(7500);
    expect(x.shares().get('m2')!.cents).toBe(2500);
  });

  it("prorata impossible sans données d'usage", async () => {
    await expect(service.addExpense({ ...base, split: { type: 'USAGE_PRORATED' } }, 'm1')).rejects.toThrow(/usage/i);
  });
});

describe('ExpenseService — cloisonnement', () => {
  it('refuse toute lecture et toute écriture à un membre hors du cercle', async () => {
    const expense = await service.addExpense({ ...base, split: { type: 'EQUAL' } }, 'm1');
    // m3 ne partage pas la minipelle : ni saisie, ni consultation, ni suppression.
    await expect(service.addExpense({ ...base, split: { type: 'EQUAL' } }, 'm3')).rejects.toThrow(ForbiddenError);
    await expect(service.listExpenses('e1', 'm3')).rejects.toThrow(ForbiddenError);
    await expect(service.listReimbursements('e1', 'm3')).rejects.toThrow(ForbiddenError);
    await expect(service.equipmentBalances('e1', 'm3')).rejects.toThrow(ForbiddenError);
    await expect(service.settlementPlan('e1', 'm3')).rejects.toThrow(ForbiddenError);
    await expect(service.deleteExpense(expense.id, 'm3')).rejects.toThrow(ForbiddenError);
    await expect(
      service.recordReimbursement(
        { equipmentId: 'e1', fromMemberId: 'm2', toMemberId: 'm1', amountEuros: 10, date: '2026-07-05' },
        'm3',
      ),
    ).rejects.toThrow(ForbiddenError);
    expect(await service.listExpenses('e1', 'm1')).toHaveLength(1);
  });
});

describe('ExpenseService — soldes et remboursements', () => {
  it("calcule les soldes du cercle de l'équipement", async () => {
    await service.addExpense({ ...base, amountEuros: 90, split: { type: 'EQUAL' } }, 'm1');
    const balances = await service.equipmentBalances('e1', 'm1');
    expect(balances.find((b) => b.memberId === 'm1')!.balanceCents).toBe(4500);
    expect(balances.find((b) => b.memberId === 'm2')!.balanceCents).toBe(-4500);
    expect(balances.some((b) => b.memberId === 'm3')).toBe(false);
  });

  it('propose un plan de remboursement minimal', async () => {
    await service.addExpense({ ...base, amountEuros: 90, split: { type: 'EQUAL' } }, 'm1');
    const plan = await service.settlementPlan('e1', 'm1');
    expect(plan).toHaveLength(1);
    expect(plan[0]!.fromMemberId).toBe('m2');
    expect(plan[0]!.toMemberId).toBe('m1');
    expect(plan[0]!.amountCents).toBe(4500);
  });

  it('un remboursement déclaré apure le solde', async () => {
    await service.addExpense({ ...base, amountEuros: 90, split: { type: 'EQUAL' } }, 'm1');
    await service.recordReimbursement(
      {
        equipmentId: 'e1',
        fromMemberId: 'm2',
        toMemberId: 'm1',
        amountEuros: 45,
        date: '2026-07-02',
      },
      'm1',
    );
    const balances = await service.equipmentBalances('e1', 'm1');
    expect(balances.find((b) => b.memberId === 'm2')!.balanceCents).toBe(0);
    expect(await service.settlementPlan('e1', 'm1')).toHaveLength(0);
  });

  it('refuse un remboursement impliquant un membre hors du cercle', async () => {
    await expect(
      service.recordReimbursement(
        {
          equipmentId: 'e1',
          fromMemberId: 'm3',
          toMemberId: 'm1',
          amountEuros: 10,
          date: '2026-07-02',
        },
        'm1',
      ),
    ).rejects.toThrow(/cercle/i);
  });

  it("liste les dépenses et remboursements de l'équipement", async () => {
    await service.addExpense({ ...base, split: { type: 'EQUAL' } }, 'm1');
    await service.recordReimbursement(
      {
        equipmentId: 'e1',
        fromMemberId: 'm2',
        toMemberId: 'm1',
        amountEuros: 10,
        date: '2026-07-02',
      },
      'm1',
    );
    expect(await service.listExpenses('e1', 'm1')).toHaveLength(1);
    expect(await service.listReimbursements('e1', 'm1')).toHaveLength(1);
  });

  it('supprime une dépense', async () => {
    const x = await service.addExpense({ ...base, split: { type: 'EQUAL' } }, 'm1');
    await service.deleteExpense(x.id, 'm1');
    expect(await service.listExpenses('e1', 'm1')).toHaveLength(0);
  });
});
