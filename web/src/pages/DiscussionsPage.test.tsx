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

  it('répond à un message précis et déplie le sous-fil', async () => {
    const user = userEvent.setup();
    render(<DiscussionsPage members={members} currentMemberId="m1" initialEquipmentId="e1" initialThreadId="t1" />);
    await screen.findByText('Bruit au démarrage.');

    await user.click(screen.getByRole('button', { name: 'Répondre' }));
    await user.type(screen.getByPlaceholderText('Répondre à Alice…'), 'Le démarreur, sans doute.');
    await user.click(screen.getByRole('button', { name: 'Envoyer la réponse' }));

    // La réponse porte l'identifiant du message auquel elle répond : c'est ce qui la range
    // dans le sous-fil plutôt qu'à la racine.
    await waitFor(() => expect(stub.postMessage).toHaveBeenCalledWith('t1', 'Le démarreur, sans doute.', 'msg1'));
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

describe('pièce jointe', () => {
  const fichier = () => new File(['PNGPANNE'], 'panne.png', { type: 'image/png' });

  it('joint un fichier au message et le rappelle avant l’envoi', async () => {
    const user = userEvent.setup();
    render(<DiscussionsPage members={members} currentMemberId="m1" initialEquipmentId="e1" initialThreadId="t1" />);
    await screen.findByText('Bruit au démarrage.');

    await user.upload(screen.getByLabelText('Joindre un fichier au message'), fichier());
    // Le fichier est rappelé tant qu'il n'est pas parti.
    expect(screen.getByText('panne.png')).toBeTruthy();

    await user.type(screen.getByPlaceholderText('Écrire un message…'), 'Regardez');
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));

    await waitFor(() =>
      expect(stub.postMessageWithFile).toHaveBeenCalledWith('t1', expect.any(File), { body: 'Regardez' }),
    );
    expect(stub.postMessage).not.toHaveBeenCalled();
    // Le rappel disparaît une fois le message parti.
    await waitFor(() => expect(screen.queryByText('panne.png')).toBeNull());
  });

  // Envoyer une photo sans commentaire est un geste normal : le bouton doit s'armer sans texte.
  it('permet d’envoyer un fichier seul, sans texte', async () => {
    const user = userEvent.setup();
    render(<DiscussionsPage members={members} currentMemberId="m1" initialEquipmentId="e1" initialThreadId="t1" />);
    await screen.findByText('Bruit au démarrage.');

    expect(screen.getByRole('button', { name: 'Envoyer' }).hasAttribute('disabled')).toBe(true);
    await user.upload(screen.getByLabelText('Joindre un fichier au message'), fichier());
    expect(screen.getByRole('button', { name: 'Envoyer' }).hasAttribute('disabled')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    await waitFor(() => expect(stub.postMessageWithFile).toHaveBeenCalledWith('t1', expect.any(File), { body: '' }));
  });

  it('retire le fichier retenu sans envoyer', async () => {
    const user = userEvent.setup();
    render(<DiscussionsPage members={members} currentMemberId="m1" initialEquipmentId="e1" initialThreadId="t1" />);
    await screen.findByText('Bruit au démarrage.');

    await user.upload(screen.getByLabelText('Joindre un fichier au message'), fichier());
    await user.click(screen.getByRole('button', { name: 'Retirer le fichier' }));

    expect(screen.queryByText('panne.png')).toBeNull();
    expect(stub.postMessageWithFile).not.toHaveBeenCalled();
  });

  it('joint un fichier à une réponse', async () => {
    const user = userEvent.setup();
    render(<DiscussionsPage members={members} currentMemberId="m1" initialEquipmentId="e1" initialThreadId="t1" />);
    await screen.findByText('Bruit au démarrage.');

    await user.click(screen.getByRole('button', { name: 'Répondre' }));
    await user.upload(screen.getByLabelText('Joindre un fichier à la réponse'), fichier());
    await user.click(screen.getByRole('button', { name: 'Envoyer la réponse' }));

    await waitFor(() =>
      expect(stub.postMessageWithFile).toHaveBeenCalledWith('t1', expect.any(File), { body: '', parentId: 'msg1' }),
    );
  });

  // Le contenu est servi par une redirection vers le stockage d'objets : c'est un lien du
  // navigateur, jamais un `fetch`, que `connect-src 'self'` bloquerait.
  it('affiche le fichier d’un message reçu comme un lien vers l’API', async () => {
    stub.listMessages.mockResolvedValue([
      aMessage({
        id: 'msg1',
        threadId: 't1',
        body: 'Le voilà',
        attachment: { fileName: 'panne.png', contentType: 'image/png', sizeBytes: 240_000 },
      }),
    ]);
    render(<DiscussionsPage members={members} currentMemberId="m1" initialEquipmentId="e1" initialThreadId="t1" />);
    await screen.findByText('Le voilà');

    const lien = screen.getByRole('link', { name: /panne\.png/ });
    expect(lien.getAttribute('href')).toBe('/api/messages/msg1/attachment');
    expect(lien.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText('240 Ko')).toBeTruthy();
  });

  it('affiche un message qui n’a qu’un fichier, sans corps', async () => {
    stub.listMessages.mockResolvedValue([
      aMessage({
        id: 'msg1',
        threadId: 't1',
        body: '',
        attachment: { fileName: 'devis.pdf', contentType: 'application/pdf', sizeBytes: 12_000 },
      }),
    ]);
    render(<DiscussionsPage members={members} currentMemberId="m1" initialEquipmentId="e1" initialThreadId="t1" />);
    expect(await screen.findByRole('link', { name: /devis\.pdf/ })).toBeTruthy();
  });
});
