import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ApiModule from '../api';
import { LotPage } from './LotPage';
import { ApiError } from '../api';
import { aSubEquipment, anEquipment, createApiStub } from '../test/factories';
import type { ApiStub } from '../test/factories';

const mocks = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: mocks.api };
});

let stub: ApiStub;

const minipelle = anEquipment({ id: 'e1', name: 'Minipelle' });

beforeEach(() => {
  stub = createApiStub();
  for (const key of Object.keys(mocks.api)) delete mocks.api[key];
  Object.assign(mocks.api, stub);
});

function renderPage() {
  return render(<LotPage equipment={minipelle} />);
}

describe('contenu du lot (sous-équipements)', () => {
  it('détaille le lot dès l’ouverture de la sous-vue', async () => {
    stub.listSubEquipments.mockResolvedValue([
      aSubEquipment({ id: 's1', name: 'Remorque', notes: 'Plaque AB-123-CD' }),
      aSubEquipment({ id: 's2', name: 'Godets', quantity: 3, position: 1 }),
    ]);
    renderPage();

    expect(await screen.findByText('Remorque')).toBeTruthy();
    expect(screen.getByText('Plaque AB-123-CD')).toBeTruthy();
    expect(screen.getByText('Godets')).toBeTruthy();
    expect(screen.getByText('3 ×')).toBeTruthy();
  });

  it('annonce le lot vide en une ligne, sans mode d’emploi', async () => {
    renderPage();

    expect(await screen.findByText('Le lot est vide.')).toBeTruthy();
    expect(screen.queryByText(/pompe à graisse/)).toBeNull();
    expect(screen.getByPlaceholderText('Remorque, godet, jerrican…')).toBeTruthy();
  });

  it('ajoute un élément au lot puis relit la liste', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Nom du sous-équipement à ajouter'), 'Jerrican');
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
    await waitFor(() => expect(stub.listSubEquipments).toHaveBeenCalledTimes(2));
  });

  it('corrige la quantité d’un élément du lot', async () => {
    const user = userEvent.setup();
    stub.listSubEquipments.mockResolvedValue([aSubEquipment({ id: 's2', name: 'Godets', quantity: 2 })]);
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Modifier Godets' }));
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
    stub.listSubEquipments.mockResolvedValue([aSubEquipment({ id: 's1', name: 'Remorque' })]);
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Retirer Remorque du lot' }));
    await waitFor(() => expect(stub.deleteSubEquipment).toHaveBeenCalledWith('s1'));
  });

  it('affiche le refus du serveur sans vider le lot affiché', async () => {
    const user = userEvent.setup();
    stub.listSubEquipments.mockResolvedValue([aSubEquipment({ id: 's1', name: 'Remorque' })]);
    stub.deleteSubEquipment.mockRejectedValue(new ApiError('Sous-équipement introuvable : s1', 404));
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Retirer Remorque du lot' }));

    expect(await screen.findByText('Sous-équipement introuvable : s1')).toBeTruthy();
    expect(screen.getByText('Remorque')).toBeTruthy();
  });
});
