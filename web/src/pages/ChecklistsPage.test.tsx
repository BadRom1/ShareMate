import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ApiModule from '../api';
import { ChecklistsPage } from './ChecklistsPage';
import { aChecklist, aMember, anEquipment, createApiStub } from '../test/factories';
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
  stub.listChecklists.mockResolvedValue([aChecklist({ id: 'c1', title: 'Avant utilisation' })]);
});

function renderPage(equipment = tracteur) {
  return render(<ChecklistsPage members={members} currentMemberId="m1" equipment={equipment} />);
}

describe('checklists de l’équipement courant', () => {
  it('annonce le cercle et les checklists de l’équipement reçu en prop', async () => {
    renderPage();

    expect(await screen.findByText('Avant utilisation')).toBeDefined();
    expect(stub.listChecklists).toHaveBeenCalledWith('e1');
    expect(screen.getByText('Cercle : Alice, Bob')).toBeDefined();
  });

  it('recharge les checklists et referme celle ouverte au changement d’équipement', async () => {
    const user = userEvent.setup();
    const { rerender } = renderPage();
    await user.click(await screen.findByText('Avant utilisation'));
    expect(await screen.findByRole('heading', { name: 'Avant utilisation' })).toBeDefined();

    stub.listChecklists.mockResolvedValue([aChecklist({ id: 'c2', title: 'Après broyage' })]);
    rerender(<ChecklistsPage members={members} currentMemberId="m1" equipment={broyeur} />);

    await waitFor(() => expect(stub.listChecklists).toHaveBeenCalledWith('e2'));
    expect(await screen.findByText(/Sélectionnez une checklist/)).toBeDefined();
    expect(screen.getByText('Après broyage')).toBeDefined();
  });
});

describe('bouton flottant', () => {
  it('ouvre le formulaire de nouvelle checklist', async () => {
    const user = userEvent.setup();
    renderPage();

    const fab = await screen.findByRole('button', { name: 'Créer une checklist' });
    expect(fab.classList.contains('fab')).toBe(true);
    await user.click(fab);

    expect(await screen.findByRole('dialog', { name: 'Nouvelle checklist' })).toBeDefined();
  });

  it('s’efface pendant la consultation d’une checklist, où l’action est d’ajouter un point', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('Avant utilisation'));

    expect(await screen.findByRole('heading', { name: 'Avant utilisation' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Créer une checklist' })).toBeNull();
  });
});
