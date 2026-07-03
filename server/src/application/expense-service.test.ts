import { beforeEach, describe, expect, it } from 'vitest';
import { makeFixture } from './testing/fixture.js';
import { ExpenseService } from './expense-service.js';
import { ReservationService } from './reservation-service.js';

let f: Awaited<ReturnType<typeof makeFixture>>;
let service: ExpenseService;
let reservationService: ReservationService;

beforeEach(async () => {
  f = await makeFixture();
  service = new ExpenseService(f.expenses, f.reimbursements, f.groups, f.reservations, f.idGenerator);
  reservationService = new ReservationService(f.reservations, f.equipments, f.idGenerator, f.clock);
});

const base = {
  groupId: 'g1',
  equipmentId: 'e1',
  label: 'Plein gasoil',
  amountEuros: 90,
  payerId: 'm1',
  date: '2026-07-01',
  category: 'FUEL' as const,
};

describe('ExpenseService — saisie', () => {
  it('crée une dépense en parts égales sur tout le groupe par défaut', async () => {
    const x = await service.addExpense({ ...base, split: { type: 'EQUAL' } });
    const shares = x.shares();
    expect([...shares.keys()].sort()).toEqual(['m1', 'm2', 'm3']);
    expect(shares.get('m1')!.cents).toBe(3000);
  });

  it('crée une dépense en parts égales sur un sous-ensemble', async () => {
    const x = await service.addExpense({ ...base, split: { type: 'EQUAL', memberIds: ['m1', 'm2'] } });
    expect([...x.shares().keys()].sort()).toEqual(['m1', 'm2']);
  });

  it('refuse un payeur hors groupe', async () => {
    await expect(service.addExpense({ ...base, payerId: 'x', split: { type: 'EQUAL' } })).rejects.toThrow(/membre/i);
  });

  it('refuse une répartition incluant un non-membre', async () => {
    await expect(
      service.addExpense({ ...base, split: { type: 'EQUAL', memberIds: ['m1', 'intrus'] } }),
    ).rejects.toThrow(/membre/i);
  });

  it('répartition custom en euros', async () => {
    const x = await service.addExpense({
      ...base,
      amountEuros: 100,
      split: { type: 'CUSTOM', amountsEuros: { m1: 70, m2: 30 } },
    });
    expect(x.shares().get('m1')!.cents).toBe(7000);
  });

  it('prorata du temps d\'usage : poids issus des réservations de l\'équipement', async () => {
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
    const x = await service.addExpense({ ...base, amountEuros: 100, split: { type: 'USAGE_PRORATED' } });
    expect(x.shares().get('m1')!.cents).toBe(7500);
    expect(x.shares().get('m2')!.cents).toBe(2500);
  });

  it('prorata impossible sans données d\'usage', async () => {
    await expect(service.addExpense({ ...base, split: { type: 'USAGE_PRORATED' } })).rejects.toThrow(/usage/i);
  });

  it('prorata impossible sans équipement associé', async () => {
    await expect(
      service.addExpense({ ...base, equipmentId: null, split: { type: 'USAGE_PRORATED' } }),
    ).rejects.toThrow(/équipement/i);
  });
});

describe('ExpenseService — soldes et remboursements', () => {
  it('calcule les soldes du groupe', async () => {
    await service.addExpense({ ...base, amountEuros: 90, split: { type: 'EQUAL' } });
    const balances = await service.groupBalances('g1');
    expect(balances.find((b) => b.memberId === 'm1')!.balanceCents).toBe(6000);
    expect(balances.find((b) => b.memberId === 'm2')!.balanceCents).toBe(-3000);
  });

  it('propose un plan de remboursement minimal', async () => {
    await service.addExpense({ ...base, amountEuros: 90, split: { type: 'EQUAL' } });
    const plan = await service.settlementPlan('g1');
    expect(plan).toHaveLength(2);
    expect(plan.every((t) => t.toMemberId === 'm1')).toBe(true);
    expect(plan.reduce((s, t) => s + t.amountCents, 0)).toBe(6000);
  });

  it('un remboursement déclaré apure le solde', async () => {
    await service.addExpense({ ...base, amountEuros: 90, split: { type: 'EQUAL' } });
    await service.recordReimbursement({
      groupId: 'g1',
      fromMemberId: 'm2',
      toMemberId: 'm1',
      amountEuros: 30,
      date: '2026-07-02',
    });
    const balances = await service.groupBalances('g1');
    expect(balances.find((b) => b.memberId === 'm2')!.balanceCents).toBe(0);
    const plan = await service.settlementPlan('g1');
    expect(plan).toHaveLength(1);
    expect(plan[0]!.fromMemberId).toBe('m3');
  });

  it('refuse un remboursement entre non-membres', async () => {
    await expect(
      service.recordReimbursement({
        groupId: 'g1',
        fromMemberId: 'x',
        toMemberId: 'm1',
        amountEuros: 10,
        date: '2026-07-02',
      }),
    ).rejects.toThrow(/membre/i);
  });

  it('liste les dépenses et remboursements du groupe', async () => {
    await service.addExpense({ ...base, split: { type: 'EQUAL' } });
    await service.recordReimbursement({
      groupId: 'g1',
      fromMemberId: 'm2',
      toMemberId: 'm1',
      amountEuros: 10,
      date: '2026-07-02',
    });
    expect(await service.listExpenses('g1')).toHaveLength(1);
    expect(await service.listReimbursements('g1')).toHaveLength(1);
  });

  it('supprime une dépense', async () => {
    const x = await service.addExpense({ ...base, split: { type: 'EQUAL' } });
    await service.deleteExpense(x.id);
    expect(await service.listExpenses('g1')).toHaveLength(0);
  });
});
