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

/** Contenu du badge de non-lus, ou `null` quand il n'y en a aucune. */
function badge(): string | null {
  return document.querySelector('.bell-badge')?.textContent ?? null;
}

function croix(titre: string) {
  return screen.getByRole('button', { name: `Effacer la notification « ${titre} »` });
}

describe('NotificationBell — effacement', () => {
  it('efface une notification et la retire de la liste, badge compris', async () => {
    const utilisateur = userEvent.setup();
    stub.listNotifications.mockResolvedValue([
      aNotification({ id: 'n1', title: 'Nouveau message' }),
      aNotification({ id: 'n2', title: 'Nouvelle dépense' }),
    ]);
    stub.unreadCount.mockResolvedValue({ count: 2 });
    render(<NotificationBell onNavigate={vi.fn()} />);
    await ouvrirLaCloche(utilisateur);
    await waitFor(() => expect(badge()).toBe('2'));

    await utilisateur.click(croix('Nouveau message'));

    expect(stub.dismissNotification).toHaveBeenCalledWith('n1');
    // Retrait immédiat, sans attendre un rechargement de la liste.
    await waitFor(() => expect(screen.queryByText('Nouveau message')).toBeNull());
    await screen.findByText('Nouvelle dépense');
    // Le badge se déduit du geste : une non-lue de moins, sans second aller-retour.
    expect(badge()).toBe('1');
    expect(stub.unreadCount).toHaveBeenCalledTimes(1);
  });

  it('ne touche pas au badge en effaçant une notification déjà lue', async () => {
    const utilisateur = userEvent.setup();
    stub.listNotifications.mockResolvedValue([
      aNotification({ id: 'n1', title: 'Déjà lue', readAt: '2026-03-01T09:00:00.000Z' }),
    ]);
    stub.unreadCount.mockResolvedValue({ count: 3 });
    render(<NotificationBell onNavigate={vi.fn()} />);
    await ouvrirLaCloche(utilisateur);
    await waitFor(() => expect(badge()).toBe('3'));

    await utilisateur.click(croix('Déjà lue'));

    await waitFor(() => expect(screen.queryByText('Déjà lue')).toBeNull());
    // Elle ne comptait pas dans les non-lues : le badge ne bouge pas.
    expect(badge()).toBe('3');
  });

  it('rend le focus à la ligne qui prend la place de celle qui part', async () => {
    const utilisateur = userEvent.setup();
    stub.listNotifications.mockResolvedValue([
      aNotification({ id: 'n1', title: 'Nouveau message' }),
      aNotification({ id: 'n2', title: 'Nouvelle dépense' }),
    ]);
    render(<NotificationBell onNavigate={vi.fn()} />);
    await ouvrirLaCloche(utilisateur);

    await utilisateur.click(croix('Nouveau message'));

    // Sans ce report, le focus retombe sur `document.body` : au clavier, chaque effacement
    // renverrait en haut de la page.
    await waitFor(() => expect(document.activeElement).toBe(croix('Nouvelle dépense')));
  });

  it('remet la ligne quand le serveur refuse, et quand la liste ne répond pas non plus', async () => {
    const utilisateur = userEvent.setup();
    stub.listNotifications.mockResolvedValue([aNotification({ id: 'n1', title: 'Nouveau message' })]);
    stub.dismissNotification.mockRejectedValue(new Error('Réseau indisponible.'));
    // La panne banale coupe les deux appels : le rechargement de secours échoue aussi.
    stub.listNotifications.mockImplementationOnce(async () => [aNotification({ id: 'n1', title: 'Nouveau message' })]);
    render(<NotificationBell onNavigate={vi.fn()} />);
    await ouvrirLaCloche(utilisateur);
    stub.listNotifications.mockRejectedValue(new Error('Réseau indisponible.'));

    await utilisateur.click(croix('Nouveau message'));

    await screen.findByRole('alert');
    // La ligne revient : un centre affiché vide qui ne l'est pas serait un mensonge.
    await screen.findByText('Nouveau message');
    expect(screen.queryByText('Aucune notification.')).toBeNull();
  });

  it('vide le centre après confirmation, et le laisse intact si elle est annulée', async () => {
    const utilisateur = userEvent.setup();
    stub.listNotifications.mockResolvedValue([aNotification({ id: 'n1' }), aNotification({ id: 'n2' })]);
    stub.unreadCount.mockResolvedValue({ count: 2 });
    render(<NotificationBell onNavigate={vi.fn()} />);
    await ouvrirLaCloche(utilisateur);

    await utilisateur.click(screen.getByRole('button', { name: 'Tout effacer' }));
    // Le clic dans la boîte — qui vit dans un portail — ne referme pas le panneau derrière elle.
    await utilisateur.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Annuler' }));
    expect(stub.dismissAllNotifications).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await screen.findByRole('button', { name: 'Tout effacer' });

    await utilisateur.click(screen.getByRole('button', { name: 'Tout effacer' }));
    const boîte = await screen.findByRole('alertdialog');
    await utilisateur.click(within(boîte).getByRole('button', { name: 'Tout effacer' }));

    expect(stub.dismissAllNotifications).toHaveBeenCalledTimes(1);
    await screen.findByText('Aucune notification.');
    // Centre vide ⇒ badge éteint, sans redemander le compte : un « 2 » au-dessus d'une liste
    // vide proposerait un « Tout lire » qui ne lit rien.
    expect(badge()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tout lire' })).toBeNull();
  });

  it('éteint le badge sur « Tout lire », et rend visible un refus du serveur', async () => {
    const utilisateur = userEvent.setup();
    stub.listNotifications.mockResolvedValue([aNotification({ id: 'n1' })]);
    stub.unreadCount.mockResolvedValue({ count: 1 });
    stub.markAllNotificationsRead.mockRejectedValueOnce(new Error('Réseau indisponible.'));
    render(<NotificationBell onNavigate={vi.fn()} />);
    await ouvrirLaCloche(utilisateur);
    await waitFor(() => expect(badge()).toBe('1'));

    await utilisateur.click(screen.getByRole('button', { name: 'Tout lire' }));
    // Premier essai refusé : l'échec est dit, le badge n'a pas menti sur un succès.
    await screen.findByRole('alert');
    expect(badge()).toBe('1');

    await utilisateur.click(screen.getByRole('button', { name: 'Tout lire' }));
    await waitFor(() => expect(badge()).toBeNull());
  });

  it('ne propose pas de vider un centre déjà vide', async () => {
    const utilisateur = userEvent.setup();
    render(<NotificationBell onNavigate={vi.fn()} />);
    await ouvrirLaCloche(utilisateur);

    await screen.findByText('Aucune notification.');
    expect(screen.queryByRole('button', { name: 'Tout effacer' })).toBeNull();
  });

  it('ferme le panneau par Échap, mais laisse la main à la confirmation ouverte', async () => {
    const utilisateur = userEvent.setup();
    stub.listNotifications.mockResolvedValue([aNotification({ id: 'n1' })]);
    render(<NotificationBell onNavigate={vi.fn()} />);
    await ouvrirLaCloche(utilisateur);

    await utilisateur.click(screen.getByRole('button', { name: 'Tout effacer' }));
    await utilisateur.keyboard('{Escape}');
    // Un seul appui n'emporte pas les deux : la boîte partie, le panneau reste.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Tout effacer' })).toBeTruthy();

    await utilisateur.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('Notifications', { selector: 'strong' })).toBeNull());
  });

  it('ne garde pas une confirmation en cours quand le panneau se referme', async () => {
    const utilisateur = userEvent.setup();
    stub.listNotifications.mockResolvedValue([aNotification({ id: 'n1' })]);
    render(<NotificationBell onNavigate={vi.fn()} />);
    await ouvrirLaCloche(utilisateur);

    await utilisateur.click(screen.getByRole('button', { name: 'Tout effacer' }));
    // Le panneau se referme sans passer par « Annuler » : la boîte est démontée telle quelle.
    await utilisateur.click(screen.getByRole('button', { name: 'Notifications' }));
    await waitFor(() => expect(screen.queryByText('Notifications', { selector: 'strong' })).toBeNull());

    await ouvrirLaCloche(utilisateur);
    // Ni confirmation resurgie sans être demandée…
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // …ni garde restée coincée : le clic extérieur referme de nouveau.
    await utilisateur.click(document.body);
    await waitFor(() => expect(screen.queryByText('Notifications', { selector: 'strong' })).toBeNull());
  });
});
