import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ApiModule from '../api';
import { UsagePage } from './UsagePage';
import { aMaintenanceStatus, aMember, aUsageRecord, anEquipment, createApiStub } from '../test/factories';
import type { ApiStub } from '../test/factories';

const mocks = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: mocks.api };
});

let stub: ApiStub;

const members = [aMember({ id: 'm1', name: 'Alice' }), aMember({ id: 'm2', name: 'Bob' })];

beforeEach(() => {
  localStorage.clear();
  stub = createApiStub();
  for (const key of Object.keys(mocks.api)) delete mocks.api[key];
  Object.assign(mocks.api, stub);
  stub.listEquipments.mockResolvedValue([
    anEquipment({ id: 'e1', name: 'Tracteur', memberIds: ['m1', 'm2'] }),
    anEquipment({ id: 'e2', name: 'Broyeur', memberIds: ['m1'] }),
  ]);
  stub.maintenanceStatus.mockResolvedValue(aMaintenanceStatus({ currentReading: 100 }));
});

function renderPage() {
  return render(<UsagePage members={members} currentMemberId="m1" />);
}

/** La saisie vit en modale : rien n'est renseignable tant qu'elle n'est pas ouverte. */
async function openForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Saisir un relevé' }));
  await screen.findByRole('button', { name: 'Enregistrer le relevé' });
}

describe('historique', () => {
  it('montre les relevés sans le formulaire de saisie', async () => {
    stub.usageByEquipment.mockResolvedValue([aUsageRecord({ meterReading: 120, duration: 4 })]);
    renderPage();

    expect(await screen.findByText('120')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Enregistrer le relevé' })).toBeNull();
  });

  it("recharge l'historique de l'équipement choisi dans l'en-tête", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(stub.usageByEquipment).toHaveBeenCalledWith('e1'));

    await user.selectOptions(screen.getByLabelText('Équipement affiché'), 'e2');

    await waitFor(() => expect(stub.usageByEquipment).toHaveBeenCalledWith('e2'));
  });
});

describe('saisie du relevé', () => {
  it('enregistre la durée saisie et referme la modale', async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    await user.type(screen.getByLabelText(/Durée d'utilisation/), '5');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le relevé' }));

    await waitFor(() =>
      expect(stub.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ equipmentId: 'e1', duration: 5 })),
    );
    expect(await screen.findByText('Relevé enregistré.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Enregistrer le relevé' })).toBeNull();
  });

  it("rend l'historique à l'équipement d'origine quand on annule", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(stub.usageByEquipment).toHaveBeenCalledWith('e1'));
    await openForm(user);

    await user.selectOptions(screen.getByLabelText('Équipement'), 'e2');
    await user.click(screen.getByRole('button', { name: 'Annuler' }));

    expect(screen.getByLabelText('Équipement affiché')).toHaveProperty('value', 'e1');
  });

  it("retire la confirmation dès qu'on regarde un autre historique", async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    await user.type(screen.getByLabelText(/Durée d'utilisation/), '5');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le relevé' }));
    expect(await screen.findByText('Relevé enregistré.')).toBeDefined();

    await user.selectOptions(screen.getByLabelText('Équipement affiché'), 'e2');

    expect(screen.queryByText('Relevé enregistré.')).toBeNull();
  });

  it('préremplit le compteur total avec le dernier relevé connu', async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    expect(screen.getByLabelText(/Compteur total/)).toHaveProperty('value', '100');
  });

  it('laisse la modale ouverte et affiche le refus du serveur', async () => {
    const user = userEvent.setup();
    stub.recordUsage.mockRejectedValue(new Error('Le relevé doit être supérieur au précédent.'));
    renderPage();
    await openForm(user);

    await user.type(screen.getByLabelText(/Durée d'utilisation/), '5');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le relevé' }));

    expect(await screen.findByText('Le relevé doit être supérieur au précédent.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Enregistrer le relevé' })).toBeDefined();
  });
});
