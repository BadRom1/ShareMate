import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ApiModule from './api';
import { App } from './App';
import { anEquipment, aMember, aMessage, aThread, createApiStub } from './test/factories';
import type { ApiStub } from './test/factories';

/**
 * Le client d'API est remplacé en bloc : ces tests portent sur la navigation, pas sur HTTP.
 * `setUnauthorizedHandler` est intercepté pour rejouer la déconnexion globale (401) sans requête.
 */
const mocks = vi.hoisted(() => ({
  api: {} as Record<string, unknown>,
  unauthorized: { handler: null as (() => void) | null },
}));

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: mocks.api,
    setUnauthorizedHandler: (handler: (() => void) | null) => {
      mocks.unauthorized.handler = handler;
    },
  };
});

let stub: ApiStub;

/** Le service worker n'existe pas en jsdom : un EventTarget suffit à rejouer ses messages. */
const serviceWorker = new EventTarget();

beforeEach(() => {
  stub = createApiStub();
  for (const key of Object.keys(mocks.api)) delete mocks.api[key];
  Object.assign(mocks.api, stub);
  mocks.unauthorized.handler = null;
  Object.defineProperty(navigator, 'serviceWorker', { value: serviceWorker, configurable: true });
  window.history.replaceState(null, '', '/');
  localStorage.clear();

  stub.listMembers.mockResolvedValue([aMember(), aMember({ id: 'm2', name: 'Bob' })]);
  stub.listEquipments.mockResolvedValue([
    anEquipment({ id: 'e1', name: 'Tracteur', memberIds: ['m1', 'm2'] }),
    anEquipment({ id: 'e2', name: 'Remorque', memberIds: ['m1', 'm2'] }),
  ]);
});

/** Section courante de la barre basse : c'est elle qui dit sur quel écran on se trouve. */
function activeTab(): string | null {
  return document.querySelector('.tabbar button[aria-current="page"]')?.textContent ?? null;
}

/** Équipement de l'espace de travail courant, tel que la barre d'app l'annonce. */
function currentEquipment(): string | null {
  return document.querySelector('.switcher-name')?.textContent ?? null;
}

/** Rejoue le message posté par le service worker au clic sur une notification Web Push. */
function clickNotification(link: string) {
  act(() => {
    serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'notification-click', link } }));
  });
}

describe('navigation par lien de notification', () => {
  it("ouvre l'onglet et l'équipement du lien dès l'ouverture de l'application", async () => {
    window.history.replaceState(null, '', '/?tab=usage&equipment=e2');

    render(<App />);

    await waitFor(() => expect(activeTab()).toBe('Entretien'));
    expect(currentEquipment()).toBe('Remorque');
    // L'onglet est marqué actif avant que `UsagePage` n'ait lancé sa requête : attendre l'appel
    // plutôt que le supposer déjà parti, sinon l'assertion court après l'effet (échec intermittent).
    await waitFor(() => expect(stub.usageByEquipment).toHaveBeenCalledWith('e2'));
  });

  // Un lien de notification de message pointe un fil précis : s'il n'est pas ouvert, le membre
  // atterrit sur une liste de fils sans savoir lequel a bougé.
  it('ouvre le fil de discussion désigné par le lien', async () => {
    window.history.replaceState(null, '', '/?tab=discussions&equipment=e2&thread=t9');
    stub.listThreads.mockResolvedValue([aThread({ id: 't9', equipmentId: 'e2', title: 'Vidange à prévoir' })]);
    stub.listMessages.mockResolvedValue([aMessage({ threadId: 't9', body: 'Le filtre est commandé.' })]);

    render(<App />);

    expect(await screen.findByText('Le filtre est commandé.')).toBeDefined();
    expect(stub.listMessages).toHaveBeenCalledWith('t9');
  });

  it("suit un clic de notification alors que l'application est déjà ouverte", async () => {
    render(<App />);
    await waitFor(() => expect(activeTab()).toBe('Agenda'));

    clickNotification('/?tab=checklists&equipment=e2');

    await waitFor(() => expect(activeTab()).toBe('Entretien'));
    expect(currentEquipment()).toBe('Remorque');
    await waitFor(() => expect(stub.listChecklists).toHaveBeenCalledWith('e2'));
  });

  it('ouvre le fil désigné par un second lien reçu pendant la consultation', async () => {
    window.history.replaceState(null, '', '/?tab=discussions&equipment=e2&thread=t9');
    stub.listThreads.mockResolvedValue([
      aThread({ id: 't9', equipmentId: 'e2', title: 'Vidange à prévoir' }),
      aThread({ id: 't10', equipmentId: 'e2', title: 'Pneu arrière' }),
    ]);
    stub.listMessages.mockImplementation(async (threadId: string) => [
      aMessage({ threadId, body: threadId === 't9' ? 'Le filtre est commandé.' : 'Pression à vérifier.' }),
    ]);
    render(<App />);
    expect(await screen.findByText('Le filtre est commandé.')).toBeDefined();

    clickNotification('/?tab=discussions&equipment=e2&thread=t10');

    expect(await screen.findByText('Pression à vérifier.')).toBeDefined();
  });

  it("ignore un lien dont l'onglet est inconnu plutôt que de vider l'écran", async () => {
    window.history.replaceState(null, '', '/?tab=usage&equipment=e2');
    render(<App />);
    await waitFor(() => expect(activeTab()).toBe('Entretien'));

    clickNotification('/?tab=inconnu&equipment=e2');

    expect(activeTab()).toBe('Entretien');
    expect(currentEquipment()).toBe('Remorque');
  });

  // Le serveur émet `/?tab=calendar` sans équipement : la réservation annoncée peut porter sur
  // n'importe lequel. Sans équipement de repli, l'agenda s'ouvrirait sur rien.
  it("ouvre un écran utilisable quand le lien désigne un équipement qui n'est plus partagé", async () => {
    // Le membre a été retiré du cercle de `e9` depuis l'envoi de la notification.
    window.history.replaceState(null, '', '/?tab=usage&equipment=e9');

    render(<App />);

    await waitFor(() => expect(activeTab()).toBe('Entretien'));
    expect(currentEquipment()).toBe('Tracteur');
    expect(screen.queryByText(/Aucun équipement partagé avec vous/)).toBeNull();
    await waitFor(() => expect(stub.usageByEquipment).toHaveBeenCalledWith('e1'));
  });

  it("ouvre l'agenda sur un équipement par défaut quand le lien n'en désigne aucun", async () => {
    window.history.replaceState(null, '', '/?tab=calendar');

    render(<App />);

    await waitFor(() => expect(activeTab()).toBe('Agenda'));
    expect(currentEquipment()).toBe('Tracteur');
    expect(screen.queryByText(/Aucun équipement partagé avec vous/)).toBeNull();
  });
});

describe('historique du navigateur', () => {
  it("revient à l'onglet précédent au bouton Retour au lieu de sortir de l'application", async () => {
    render(<App />);
    await waitFor(() => expect(activeTab()).toBe('Agenda'));

    await userEvent.click(screen.getByRole('button', { name: 'Dépenses' }));
    await waitFor(() => expect(activeTab()).toBe('Dépenses'));

    act(() => window.history.back());

    await waitFor(() => expect(activeTab()).toBe('Agenda'));
  });
});

describe('écrans transverses', () => {
  it("ouvre la vue d'ensemble depuis le sélecteur d'équipement", async () => {
    render(<App />);
    await waitFor(() => expect(activeTab()).toBe('Agenda'));

    await userEvent.click(screen.getByRole('button', { name: /Tracteur/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Vue d’ensemble' }));

    expect(await screen.findByRole('heading', { name: 'Vue d’ensemble' })).toBeDefined();
    // L'écran transverse prend toute la place : il n'a pas les onglets d'un équipement.
    expect(activeTab()).toBeNull();
  });

  it('ouvre la gestion du parc depuis le sélecteur d’équipement', async () => {
    render(<App />);
    await waitFor(() => expect(activeTab()).toBe('Agenda'));

    await userEvent.click(screen.getByRole('button', { name: /Tracteur/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter un équipement' }));

    expect(await screen.findByRole('heading', { name: 'Mes équipements' })).toBeDefined();
    expect(activeTab()).toBeNull();
  });

  it('ferme la gestion du parc à la touche Échap, comme la vue d’ensemble', async () => {
    render(<App />);
    await waitFor(() => expect(activeTab()).toBe('Agenda'));
    await userEvent.click(screen.getByRole('button', { name: /Tracteur/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter un équipement' }));
    expect(await screen.findByRole('heading', { name: 'Mes équipements' })).toBeDefined();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(activeTab()).toBe('Agenda'));
    expect(screen.queryByRole('heading', { name: 'Mes équipements' })).toBeNull();
  });

  it('laisse la main à la boîte de confirmation ouverte par-dessus la gestion du parc', async () => {
    render(<App />);
    await waitFor(() => expect(activeTab()).toBe('Agenda'));
    await userEvent.click(screen.getByRole('button', { name: /Tracteur/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter un équipement' }));
    await userEvent.click((await screen.findAllByRole('button', { name: 'Supprimer' }))[0]);
    expect(await screen.findByRole('alertdialog')).toBeDefined();

    await userEvent.keyboard('{Escape}');

    // Un seul appui ne referme que la boîte : l'écran qui la porte reste ouvert.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Mes équipements' })).toBeDefined();
  });
});

describe('parc vide', () => {
  beforeEach(() => {
    stub.listEquipments.mockResolvedValue([]);
  });

  it('propose d’ajouter un équipement au lieu d’un écran muet', async () => {
    render(<App />);

    expect(await screen.findByText(/Aucun équipement partagé avec vous/)).toBeDefined();
    expect(currentEquipment()).toBe('Aucun équipement');
  });

  it('mène à la gestion du parc depuis l’écran de repli', async () => {
    render(<App />);
    await screen.findByText(/Aucun équipement partagé avec vous/);

    await userEvent.click(screen.getByRole('button', { name: /Ajouter un équipement/ }));

    expect(await screen.findByRole('heading', { name: 'Mes équipements' })).toBeDefined();
  });

  it('n’ouvre pas d’écran d’équipement sur un lien de notification sans parc', async () => {
    window.history.replaceState(null, '', '/?tab=usage&equipment=e2');

    render(<App />);

    expect(await screen.findByText(/Aucun équipement partagé avec vous/)).toBeDefined();
    expect(stub.usageByEquipment).not.toHaveBeenCalled();
  });
});

describe('session', () => {
  it("renvoie à l'écran de connexion quand l'API signale une session expirée", async () => {
    render(<App />);
    await waitFor(() => expect(activeTab()).toBe('Agenda'));

    stub.me.mockResolvedValue({ member: null, needsBootstrap: false });
    await act(async () => mocks.unauthorized.handler?.());

    expect(await screen.findByRole('button', { name: 'Se connecter' })).toBeDefined();
  });

  it('propose la création du premier compte quand la base est vide', async () => {
    stub.me.mockResolvedValue({ member: null, needsBootstrap: true });

    render(<App />);

    expect(await screen.findByRole('button', { name: "C'est parti" })).toBeDefined();
  });

  it("ouvre l'écran d'invitation sur une URL /invite/<code>", async () => {
    window.history.replaceState(null, '', '/invite/abc123');
    stub.inviteInfo.mockResolvedValue({ memberName: 'Bob' });

    render(<App />);

    expect(await screen.findByText('Bob')).toBeDefined();
    expect(stub.inviteInfo).toHaveBeenCalledWith('abc123');
    // L'appel `me()` est inutile ici : l'écran d'invitation ne dépend pas d'une session.
    expect(stub.me).not.toHaveBeenCalled();
  });
});
