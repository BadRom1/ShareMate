import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ApiModule from '../api';
import { DiscussionsPage } from './DiscussionsPage';
import { aMember, aMessage, aThread, anEquipment, createApiStub } from '../test/factories';
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
  window.localStorage.clear();
  stub.listEquipments.mockResolvedValue([
    anEquipment({ id: 'e1', name: 'Tracteur', memberIds: ['m1', 'm2'] }),
    anEquipment({ id: 'e2', name: 'Broyeur', memberIds: ['m1', 'm2'] }),
  ]);
  stub.listThreads.mockResolvedValue([aThread({ id: 't1', title: 'Panne moteur', equipmentId: 'e1' })]);
  stub.listMessages.mockResolvedValue([aMessage({ id: 'msg1', threadId: 't1', body: 'Bruit au démarrage.' })]);
});

describe('ouverture d’un fil', () => {
  // Régression : le fil ciblé par une notification était refermé par un effet sur `selectedId`
  // qui s'exécute aussi au montage. Le lien menait alors à un panneau vide.
  it('ouvre au montage le fil désigné par une notification', async () => {
    render(<DiscussionsPage members={members} currentMemberId="m1" initialEquipmentId="e1" initialThreadId="t1" />);

    expect(await screen.findByText('Bruit au démarrage.')).toBeTruthy();
    expect(stub.listMessages).toHaveBeenCalledWith('t1');
  });

  it('referme le fil quand on change d’équipement, sans le rouvrir', async () => {
    const user = userEvent.setup();
    render(<DiscussionsPage members={members} currentMemberId="m1" initialEquipmentId="e1" initialThreadId="t1" />);
    await screen.findByText('Bruit au démarrage.');

    stub.listThreads.mockResolvedValue([]);
    await user.selectOptions(screen.getByLabelText('Équipement'), 'e2');

    // Le fil appartenait à l'équipement quitté : le panneau se vide et n'est pas rechargé.
    await waitFor(() => expect(screen.queryByText('Bruit au démarrage.')).toBeNull());
    expect(screen.getByText(/Sélectionnez un fil/)).toBeTruthy();
  });

  it('ouvre un fil choisi dans la liste latérale', async () => {
    const user = userEvent.setup();
    render(<DiscussionsPage members={members} currentMemberId="m1" initialEquipmentId="e1" />);

    // Sans lien de notification, aucun fil n'est ouvert au montage.
    expect(await screen.findByText(/Sélectionnez un fil/)).toBeTruthy();
    await user.click(await screen.findByText('Panne moteur'));
    expect(await screen.findByText('Bruit au démarrage.')).toBeTruthy();
  });
});
