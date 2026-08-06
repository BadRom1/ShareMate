import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ApiModule from '../api';
import { EquipmentsPage } from './EquipmentsPage';
import { ApiError } from '../api';
import { aMember, aSubEquipment, anEquipment, createApiStub } from '../test/factories';
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
    // La liste est relue : l'équipement quitté ne doit plus s'afficher. Le rechargement ne part
    // qu'une fois `leaveEquipment` résolu, d'où le `waitFor` plutôt qu'une assertion immédiate.
    await waitFor(() => expect(stub.listEquipments).toHaveBeenCalledTimes(2));
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

describe('contenu du lot (sous-équipements)', () => {
  it('affiche le lot replié, puis le détaille à l’ouverture', async () => {
    const user = userEvent.setup();
    stub.listEquipments.mockResolvedValue([anEquipment({ id: 'e1', name: 'Minipelle' })]);
    stub.listSubEquipments.mockResolvedValue([
      aSubEquipment({ id: 's1', name: 'Remorque', notes: 'Plaque AB-123-CD' }),
      aSubEquipment({ id: 's2', name: 'Godets', quantity: 3, position: 1 }),
    ]);
    renderPage();

    // Replié : le décompte suffit, le détail attend un geste.
    const toggle = await screen.findByRole('button', { name: /Contenu du lot/ });
    expect(screen.queryByText('Remorque')).toBeNull();

    await user.click(toggle);
    expect(screen.getByText('Remorque')).toBeTruthy();
    expect(screen.getByText('Plaque AB-123-CD')).toBeTruthy();
    expect(screen.getByText('Godets')).toBeTruthy();
    // La quantité n'est affichée que lorsqu'il y a plus d'un exemplaire.
    expect(screen.getByText('3 ×')).toBeTruthy();
  });

  it('ajoute un élément au lot puis relit la liste', async () => {
    const user = userEvent.setup();
    stub.listEquipments.mockResolvedValue([anEquipment({ id: 'e1', name: 'Minipelle' })]);
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Contenu du lot/ }));
    await user.type(screen.getByLabelText('Nom du sous-équipement à ajouter'), 'Jerrican');
    await user.clear(screen.getByLabelText('Quantité à ajouter'));
    await user.type(screen.getByLabelText('Quantité à ajouter'), '2');
    await user.type(screen.getByLabelText('Précision à ajouter'), '20 L');
    await user.click(screen.getByRole('button', { name: 'Ajouter au lot' }));

    await waitFor(() =>
      expect(stub.addSubEquipment).toHaveBeenCalledWith({
        equipmentId: 'e1',
        name: 'Jerrican',
        quantity: 2,
        notes: '20 L',
      }),
    );
    // Le lot est relu avec la liste des équipements : l'ajout doit apparaître sans recharger la page.
    await waitFor(() => expect(stub.listSubEquipments).toHaveBeenCalledTimes(2));
  });

  it('corrige la quantité d’un élément du lot', async () => {
    const user = userEvent.setup();
    stub.listEquipments.mockResolvedValue([anEquipment({ id: 'e1', name: 'Minipelle' })]);
    stub.listSubEquipments.mockResolvedValue([aSubEquipment({ id: 's2', name: 'Godets', quantity: 2 })]);
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Contenu du lot/ }));
    await user.click(screen.getByRole('button', { name: 'Modifier Godets' }));
    const quantité = screen.getByLabelText('Quantité');
    await user.clear(quantité);
    await user.type(quantité, '4');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() =>
      expect(stub.updateSubEquipment).toHaveBeenCalledWith('s2', { name: 'Godets', quantity: 4, notes: null }),
    );
  });

  it('retire un élément du lot', async () => {
    const user = userEvent.setup();
    stub.listEquipments.mockResolvedValue([anEquipment({ id: 'e1', name: 'Minipelle' })]);
    stub.listSubEquipments.mockResolvedValue([aSubEquipment({ id: 's1', name: 'Remorque' })]);
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Contenu du lot/ }));
    await user.click(screen.getByRole('button', { name: 'Retirer Remorque du lot' }));
    await waitFor(() => expect(stub.deleteSubEquipment).toHaveBeenCalledWith('s1'));
  });

  it('affiche le refus du serveur sans vider le lot affiché', async () => {
    const user = userEvent.setup();
    stub.listEquipments.mockResolvedValue([anEquipment({ id: 'e1', name: 'Minipelle' })]);
    stub.listSubEquipments.mockResolvedValue([aSubEquipment({ id: 's1', name: 'Remorque' })]);
    stub.deleteSubEquipment.mockRejectedValue(new ApiError('Sous-équipement introuvable : s1', 404));
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Contenu du lot/ }));
    await user.click(screen.getByRole('button', { name: 'Retirer Remorque du lot' }));

    expect(await screen.findByText('Sous-équipement introuvable : s1')).toBeTruthy();
    expect(screen.getByText('Remorque')).toBeTruthy();
  });
});
