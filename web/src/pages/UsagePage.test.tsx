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
const tracteur = anEquipment({ id: 'e1', name: 'Tracteur', memberIds: ['m1', 'm2'] });
const broyeur = anEquipment({ id: 'e2', name: 'Broyeur', memberIds: ['m1'] });

beforeEach(() => {
  localStorage.clear();
  stub = createApiStub();
  for (const key of Object.keys(mocks.api)) delete mocks.api[key];
  Object.assign(mocks.api, stub);
  stub.maintenanceStatus.mockResolvedValue(aMaintenanceStatus({ currentReading: 100 }));
});

function renderPage(equipment = tracteur) {
  return render(<UsagePage members={members} currentMemberId="m1" equipment={equipment} />);
}

/**
 * La saisie vit en modale : rien n'est renseignable tant qu'elle n'est pas ouverte, et le seul
 * déclencheur est le bouton flottant — un bouton ordinaire remis dans le flux ferait échouer ici.
 */
async function openForm(user: ReturnType<typeof userEvent.setup>) {
  const fab = await screen.findByRole('button', { name: 'Saisir un relevé' });
  expect(fab.classList.contains('fab')).toBe(true);
  await user.click(fab);
  await screen.findByRole('button', { name: 'Enregistrer le relevé' });
}

describe('historique', () => {
  it('montre les relevés sans le formulaire de saisie', async () => {
    stub.usageByEquipment.mockResolvedValue([aUsageRecord({ meterReading: 120, duration: 4 })]);
    renderPage();

    expect(await screen.findByText('120')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Enregistrer le relevé' })).toBeNull();
  });

  it('affiche les décimales à la française, sans artefact de calcul flottant', async () => {
    stub.usageByEquipment.mockResolvedValue([
      aUsageRecord({ meterReading: 165.3, duration: 165.3 - 164, fuelAddedLiters: 12.5 }),
    ]);
    stub.maintenanceStatus.mockResolvedValue(
      aMaintenanceStatus({ currentReading: 165.3, unitsSinceMaintenance: 165.3 - 164, threshold: 10 }),
    );
    renderPage();

    expect(await screen.findByText('1,3 h')).toBeDefined();
    expect(screen.getByText('165,3')).toBeDefined();
    expect(screen.getByText('12,5 L')).toBeDefined();
    expect(screen.getByText(/165,3 h — 1,3\/10 depuis la dernière maintenance/)).toBeDefined();
  });

  it("recharge l'historique quand l'équipement de l'espace change", async () => {
    const { rerender } = renderPage();
    await waitFor(() => expect(stub.usageByEquipment).toHaveBeenCalledWith('e1'));

    rerender(<UsagePage members={members} currentMemberId="m1" equipment={broyeur} />);

    await waitFor(() => expect(stub.usageByEquipment).toHaveBeenCalledWith('e2'));
    expect(stub.maintenanceStatus).toHaveBeenCalledWith('e2');
  });

  it("ne garde que les relevés de l'équipement courant dans la vue par membre", async () => {
    const user = userEvent.setup();
    stub.usageByMember.mockResolvedValue([
      aUsageRecord({ id: 'u1', equipmentId: 'e1', meterReading: 120 }),
      aUsageRecord({ id: 'u2', equipmentId: 'e2', meterReading: 340 }),
    ]);
    renderPage();
    await screen.findByRole('button', { name: 'Saisir un relevé' });

    await user.click(screen.getByLabelText('Mes relevés uniquement'));

    expect(await screen.findByText('120')).toBeDefined();
    expect(screen.queryByText('340')).toBeNull();
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

  // Le changement d'équipement remet la page à neuf par le remontage décidé dans `App` (`key`) :
  // ce qui reste ici, c'est la bascule de l'historique, qui ne démonte rien.
  it('accepte la virgule du clavier français et convertit en compteur total', async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    await user.type(screen.getByLabelText(/Durée d'utilisation/), '1,3');

    expect(screen.getByLabelText(/Compteur total/)).toHaveProperty('value', '101,3');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le relevé' }));

    await waitFor(() =>
      expect(stub.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ equipmentId: 'e1', duration: 1.3 })),
    );
  });

  it('ignore les frappes qui ne font pas un nombre', async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    const duree = screen.getByLabelText(/Durée d'utilisation/);
    await user.type(duree, '1,3,5abc');

    expect(duree).toHaveProperty('value', '1,35');
  });

  it("retire la confirmation dès qu'on bascule l'historique", async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    await user.type(screen.getByLabelText(/Durée d'utilisation/), '5');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le relevé' }));
    expect(await screen.findByText('Relevé enregistré.')).toBeDefined();

    await user.click(screen.getByLabelText('Mes relevés uniquement'));

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
