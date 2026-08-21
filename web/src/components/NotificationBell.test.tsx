import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ApiModule from '../api';
import { NotificationBell } from './NotificationBell';
import { aNotification, createApiStub } from '../test/factories';
import type { ApiStub } from '../test/factories';

/** La cloche parle directement à l'API : le client est remplacé en bloc. */
const mocks = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: mocks.api };
});

let stub: ApiStub;

beforeEach(() => {
  stub = createApiStub();
  for (const key of Object.keys(mocks.api)) delete mocks.api[key];
  Object.assign(mocks.api, stub);
});

/** Ouvre le panneau et attend que la liste soit rendue. */
async function ouvrirLaCloche(utilisateur: ReturnType<typeof userEvent.setup>) {
  await utilisateur.click(screen.getByRole('button', { name: 'Notifications' }));
  await waitFor(() => expect(stub.listNotifications).toHaveBeenCalled());
}

describe('NotificationBell — effacement', () => {
  it('efface une notification et la retire de la liste', async () => {
    const utilisateur = userEvent.setup();
    stub.listNotifications.mockResolvedValue([
      aNotification({ id: 'n1', title: 'Nouveau message' }),
      aNotification({ id: 'n2', title: 'Nouvelle dépense' }),
    ]);
    stub.unreadCount.mockResolvedValue({ count: 2 });
    render(<NotificationBell onNavigate={vi.fn()} />);
    await ouvrirLaCloche(utilisateur);

    await utilisateur.click(screen.getByRole('button', { name: /Effacer la notification « Nouveau message »/ }));

    expect(stub.dismissNotification).toHaveBeenCalledWith('n1');
    // Retrait immédiat, sans attendre un rechargement de la liste.
    await waitFor(() => expect(screen.queryByText('Nouveau message')).toBeNull());
    expect(screen.getByText('Nouvelle dépense')).toBeTruthy();
    // Une notification non lue effacée fait baisser le badge : il est relu au serveur.
    await waitFor(() => expect(stub.unreadCount.mock.calls.length).toBeGreaterThan(1));
  });

  it('n’efface pas le panneau quand le serveur refuse : la liste reprend la main', async () => {
    const utilisateur = userEvent.setup();
    stub.listNotifications.mockResolvedValue([aNotification({ id: 'n1', title: 'Nouveau message' })]);
    stub.dismissNotification.mockRejectedValue(new Error('Notification introuvable : n1'));
    render(<NotificationBell onNavigate={vi.fn()} />);
    await ouvrirLaCloche(utilisateur);

    await utilisateur.click(screen.getByRole('button', { name: /Effacer la notification/ }));

    expect(await screen.findByText('Notification introuvable : n1')).toBeTruthy();
    // La ligne réapparaît : l'affichage ne prétend pas avoir effacé ce qui est resté.
    expect(await screen.findByText('Nouveau message')).toBeTruthy();
  });

  it('vide le centre après confirmation, et le laisse intact si elle est annulée', async () => {
    const utilisateur = userEvent.setup();
    stub.listNotifications.mockResolvedValue([aNotification({ id: 'n1' }), aNotification({ id: 'n2' })]);
    render(<NotificationBell onNavigate={vi.fn()} />);
    await ouvrirLaCloche(utilisateur);

    await utilisateur.click(screen.getByRole('button', { name: 'Tout effacer' }));
    // Le clic dans la boîte — qui vit dans un portail — ne referme pas le panneau derrière elle.
    await utilisateur.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Annuler' }));
    expect(stub.dismissAllNotifications).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Tout effacer' })).toBeTruthy();

    await utilisateur.click(screen.getByRole('button', { name: 'Tout effacer' }));
    const boîte = await screen.findByRole('alertdialog');
    await utilisateur.click(within(boîte).getByRole('button', { name: 'Tout effacer' }));

    expect(stub.dismissAllNotifications).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Aucune notification.')).toBeTruthy();
  });

  it('ne propose pas de vider un centre déjà vide', async () => {
    const utilisateur = userEvent.setup();
    render(<NotificationBell onNavigate={vi.fn()} />);
    await ouvrirLaCloche(utilisateur);

    expect(screen.getByText('Aucune notification.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tout effacer' })).toBeNull();
  });
});
