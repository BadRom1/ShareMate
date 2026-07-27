import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ApiModule from '../api';
import { ExpensesPage } from './ExpensesPage';
import { ApiError } from '../api';
import { aMember, anEquipment, anExpense, createApiStub } from '../test/factories';
import type { ApiStub } from '../test/factories';

const mocks = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: mocks.api };
});

let stub: ApiStub;

const members = [aMember({ id: 'm1', name: 'Alice' }), aMember({ id: 'm2', name: 'Bob' })];

beforeEach(() => {
  stub = createApiStub();
  for (const key of Object.keys(mocks.api)) delete mocks.api[key];
  Object.assign(mocks.api, stub);
  stub.listEquipments.mockResolvedValue([anEquipment({ id: 'e1', name: 'Tracteur', memberIds: ['m1', 'm2'] })]);
});

function renderPage() {
  return render(<ExpensesPage members={members} currentMemberId="m1" />);
}

/** Ouvre le formulaire de dépense une fois l'équipement chargé. */
async function openForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '+ Ajouter une dépense' }));
}

describe('formulaire de dépense', () => {
  it('enregistre une dépense partagée à parts égales sur tout le cercle', async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    await user.type(screen.getByLabelText('Libellé'), 'Plein de gazole');
    await user.type(screen.getByLabelText('Montant (€)'), '90');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() =>
      expect(stub.addExpense).toHaveBeenCalledWith(
        expect.objectContaining({
          equipmentId: 'e1',
          label: 'Plein de gazole',
          amountEuros: 90,
          payerId: 'm1',
          category: 'FUEL',
          split: { type: 'EQUAL', memberIds: ['m1', 'm2'] },
          receiptPath: null,
        }),
      ),
    );
  });

  it('exclut du partage les membres décochés', async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    await user.type(screen.getByLabelText('Libellé'), 'Réparation');
    await user.type(screen.getByLabelText('Montant (€)'), '120');
    await user.click(screen.getByRole('checkbox', { name: 'Bob' }));
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() =>
      expect(stub.addExpense).toHaveBeenCalledWith(
        expect.objectContaining({ split: { type: 'EQUAL', memberIds: ['m1'] } }),
      ),
    );
  });

  // Un montant vide ou nul n'est pas une part de zéro euro : le serveur refuse la répartition
  // dont la somme ne fait pas le total, l'envoyer produirait une erreur incompréhensible.
  it('ne transmet que les montants personnalisés renseignés', async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    await user.type(screen.getByLabelText('Libellé'), 'Assurance');
    await user.type(screen.getByLabelText('Montant (€)'), '200');
    await user.selectOptions(screen.getByLabelText('Répartition (au sein du cercle)'), 'CUSTOM');
    await user.type(screen.getByLabelText('Alice (€)'), '200');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() =>
      expect(stub.addExpense).toHaveBeenCalledWith(
        expect.objectContaining({ split: { type: 'CUSTOM', amountsEuros: { m1: 200 } } }),
      ),
    );
  });

  it('téléverse le justificatif avant la dépense et transmet son chemin', async () => {
    const user = userEvent.setup();
    stub.uploadReceipt.mockResolvedValue('/uploads/0189a4c2-1f3b-4d5e-8a9b-0c1d2e3f4a5b.jpg');
    renderPage();
    await openForm(user);

    await user.type(screen.getByLabelText('Libellé'), 'Filtre à huile');
    await user.type(screen.getByLabelText('Montant (€)'), '35');
    await user.upload(
      screen.getByLabelText('Justificatif (image ou PDF, optionnel)'),
      new File(['x'], 'facture.jpg', { type: 'image/jpeg' }),
    );
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() =>
      expect(stub.addExpense).toHaveBeenCalledWith(
        expect.objectContaining({ receiptPath: '/uploads/0189a4c2-1f3b-4d5e-8a9b-0c1d2e3f4a5b.jpg' }),
      ),
    );
  });

  it("affiche le message du serveur quand l'enregistrement échoue", async () => {
    const user = userEvent.setup();
    stub.addExpense.mockRejectedValue(new ApiError('La somme des parts doit égaler le montant.', 400));
    renderPage();
    await openForm(user);

    await user.type(screen.getByLabelText('Libellé'), 'Gazole');
    await user.type(screen.getByLabelText('Montant (€)'), '90');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(await screen.findByText('La somme des parts doit égaler le montant.')).toBeDefined();
    // Le formulaire reste ouvert : la saisie ne doit pas être perdue.
    expect(screen.getByLabelText('Libellé')).toHaveProperty('value', 'Gazole');
  });
});

describe('affichage des parts et des soldes', () => {
  it('détaille la part de chaque membre sur la ligne de dépense', async () => {
    stub.listExpenses.mockResolvedValue([anExpense({ label: 'Plein de gazole', sharesEuros: { m1: 45, m2: 45 } })]);
    renderPage();

    const row = await screen.findByRole('row', { name: /Plein de gazole/ });
    expect(row.textContent).toContain('Alice 45');
    expect(row.textContent).toContain('Bob 45');
  });

  it("signe les soldes : positif quand le cercle doit de l'argent au membre", async () => {
    stub.balances.mockResolvedValue([
      { memberId: 'm1', balanceEuros: 45 },
      { memberId: 'm2', balanceEuros: -45 },
    ]);
    renderPage();

    const row = await screen.findByRole('row', { name: /Alice/ });
    expect(row.querySelector('.amount-pos')?.textContent).toMatch(/^\+45/);
    expect(document.querySelector('.amount-neg')?.textContent).toMatch(/^-45/);
  });

  it('propose de solder les dettes du plan de remboursement', async () => {
    const user = userEvent.setup();
    stub.settlement.mockResolvedValue([{ fromMemberId: 'm2', toMemberId: 'm1', amountEuros: 45 }]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Marquer remboursé' }));

    await waitFor(() =>
      expect(stub.recordReimbursement).toHaveBeenCalledWith(
        expect.objectContaining({ equipmentId: 'e1', fromMemberId: 'm2', toMemberId: 'm1', amountEuros: 45 }),
      ),
    );
  });
});
