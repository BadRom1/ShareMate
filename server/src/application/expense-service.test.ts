import { beforeEach, describe, expect, it } from 'vitest';
import { makeFixture } from './testing/fixture.js';
import { ExpenseService } from './expense-service.js';
import { ForbiddenError, NotFoundError } from '../domain/shared/domain-error.js';
import { Expense } from '../domain/expense/expense.js';
import { Money } from '../domain/shared/money.js';
import { ReservationService } from './reservation-service.js';
import { NullNotifier } from './testing/in-memory.js';

let f: Awaited<ReturnType<typeof makeFixture>>;
let service: ExpenseService;
let reservationService: ReservationService;

beforeEach(async () => {
  f = await makeFixture();
  service = new ExpenseService(
    f.expenses,
    f.reimbursements,
    f.equipments,
    f.reservations,
    f.idGenerator,
    f.members,
    new NullNotifier(),
    f.receipts,
  );
  reservationService = new ReservationService(
    f.reservations,
    f.equipments,
    f.idGenerator,
    f.clock,
    f.members,
    new NullNotifier(),
  );
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

/** Chemin tel que produit par le téléversement d'un justificatif. */
const RECEIPT = '/uploads/8f14e45f-ceea-467a-a3f6-9b1f3e2c7d40.png';

describe('ExpenseService — justificatifs', () => {
  /** Dépense sur e1 (cercle m1/m2) portant un justificatif déjà déposé. */
  async function dépenseAvecJustificatif() {
    f.receipts.add(RECEIPT);
    return service.addExpense({ ...base, split: { type: 'EQUAL' }, receiptPath: RECEIPT }, 'm1');
  }

  it('supprime le fichier avec la dépense qui le portait', async () => {
    const x = await dépenseAvecJustificatif();
    await service.deleteExpense(x.id, 'm1');
    expect(f.receipts.paths.has(RECEIPT)).toBe(false);
  });

  it('conserve le fichier tant qu’une autre dépense le porte', async () => {
    const x = await dépenseAvecJustificatif();
    // Doublon désormais impossible via addExpense : seules d'anciennes données en comptent.
    await f.expenses.save(
      Expense.create({
        id: 'jumelle',
        equipmentId: 'e1',
        label: 'Même reçu',
        amount: Money.fromEuros(10),
        payerId: 'm1',
        date: new Date('2026-07-02'),
        category: 'FUEL',
        split: { type: 'EQUAL', memberIds: ['m1'] },
        receiptPath: RECEIPT,
      }),
    );
    await service.deleteExpense(x.id, 'm1');
    expect(f.receipts.paths.has(RECEIPT)).toBe(true);
  });

  it('refuse de rattacher un justificatif déjà porté par une dépense', async () => {
    await dépenseAvecJustificatif();
    await expect(service.addExpense({ ...base, split: { type: 'EQUAL' }, receiptPath: RECEIPT }, 'm2')).rejects.toThrow(
      /déjà rattaché/i,
    );
  });

  it('n’ouvre le justificatif qu’aux membres du cercle de sa dépense', async () => {
    const x = await dépenseAvecJustificatif();
    expect((await service.receiptOwner(RECEIPT, 'm2')).id).toBe(x.id);

    // m3 est hors du cercle : refus masqué derrière l'absence, mot pour mot celle d'un
    // justificatif jamais déposé (ForbiddenError et NotFoundError sont tous deux rendus en 404).
    const jamaisDéposé = '/uploads/00000000-0000-4000-8000-000000000000.png';
    await expect(service.receiptOwner(RECEIPT, 'm3')).rejects.toThrow(ForbiddenError);
    await expect(service.receiptOwner(RECEIPT, 'm3')).rejects.toThrow(`Justificatif introuvable : ${RECEIPT}`);
    await expect(service.receiptOwner(jamaisDéposé, 'm1')).rejects.toThrow(NotFoundError);
    await expect(service.receiptOwner(jamaisDéposé, 'm1')).rejects.toThrow(
      `Justificatif introuvable : ${jamaisDéposé}`,
    );
  });
});
