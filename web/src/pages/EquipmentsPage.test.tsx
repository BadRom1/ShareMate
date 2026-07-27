import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ApiModule from '../api';
import { EquipmentsPage } from './EquipmentsPage';
import { ApiError } from '../api';
import { aMember, anEquipment, createApiStub } from '../test/factories';
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
});

function renderPage() {
  return render(<EquipmentsPage members={members} currentMemberId="m1" onMembersChanged={() => {}} />);
}

describe('quitter le cercle', () => {
  // Geste irréversible : seul un membre restant peut réintégrer le partant. Il ne doit jamais
  // partir d'un simple clic, et l'écran doit dire ce qui est perdu avant de le confirmer.
  it('demande confirmation, en annonçant ce qui disparaît, avant d’appeler le serveur', async () => {
    const user = userEvent.setup();
    stub.listEquipments.mockResolvedValue([anEquipment({ id: 'e1', name: 'Tracteur', memberIds: ['m1', 'm2'] })]);
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Quitter le cercle' }));
    expect(screen.getByText('Quitter le cercle de « Tracteur » ?')).toBeTruthy();
    expect(stub.leaveEquipment).not.toHaveBeenCalled();

    // Le second est celui de la modale : le premier reste l'icône de la carte.
    await user.click(screen.getAllByRole('button', { name: 'Quitter le cercle' })[1]!);
    await waitFor(() => expect(stub.leaveEquipment).toHaveBeenCalledWith('e1'));
    // La liste est relue : l'équipement quitté ne doit plus s'afficher.
    expect(stub.listEquipments).toHaveBeenCalledTimes(2);
  });

  it('n’offre pas de quitter un cercle dont on est le dernier membre', async () => {
    stub.listEquipments.mockResolvedValue([anEquipment({ id: 'e1', name: 'Tracteur', memberIds: ['m1'] })]);
    renderPage();

    await screen.findByText('Tracteur');
    // Le serveur refuserait (l'équipement deviendrait invisible pour tous) : l'écran ne le propose
    // pas. Il reste la suppression, qui, elle, dit qu'elle est définitive.
    expect(screen.queryByRole('button', { name: 'Quitter le cercle' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Supprimer' })).toBeTruthy();
  });

  it('affiche le refus du serveur sans faire disparaître l’équipement', async () => {
    const user = userEvent.setup();
    stub.listEquipments.mockResolvedValue([anEquipment({ id: 'e1', name: 'Tracteur', memberIds: ['m1', 'm2'] })]);
    stub.leaveEquipment.mockRejectedValue(new ApiError('Équipement introuvable : e1', 404));
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Quitter le cercle' }));
    await user.click(screen.getAllByRole('button', { name: 'Quitter le cercle' })[1]!);

    expect(await screen.findByText('Équipement introuvable : e1')).toBeTruthy();
    expect(screen.getByText('Tracteur')).toBeTruthy();
  });
});
