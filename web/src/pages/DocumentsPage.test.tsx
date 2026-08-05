import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ApiModule from '../api';
import { DocumentsPage } from './DocumentsPage';
import { aDocument, aDocumentLink, aMember, anEquipment, createApiStub } from '../test/factories';
import type { ApiStub } from '../test/factories';

const mocks = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: mocks.api };
});

let stub: ApiStub;

const members = [aMember({ id: 'm1', name: 'Alice' }), aMember({ id: 'm2', name: 'Bob' })];

/** Ligne d'un document, repérée par son nom affiché. */
function ligne(nom: string): HTMLElement {
  const titre = screen.getByText(nom);
  const item = titre.closest('li');
  if (!item) throw new Error(`Aucune ligne pour « ${nom} »`);
  return item;
}

/** Sous-titre d'une ligne, recomposé : React le rend en plusieurs nœuds de texte. */
function sousTitre(nom: string): string {
  return ligne(nom).querySelector('.doc-sub')?.textContent ?? '';
}

beforeEach(() => {
  stub = createApiStub();
  for (const key of Object.keys(mocks.api)) delete mocks.api[key];
  Object.assign(mocks.api, stub);
  window.localStorage.clear();
  stub.listEquipments.mockResolvedValue([
    anEquipment({ id: 'e1', name: 'Tracteur', memberIds: ['m1', 'm2'] }),
    anEquipment({ id: 'e2', name: 'Broyeur', memberIds: ['m1', 'm2'] }),
  ]);
  stub.listDocuments.mockResolvedValue([
    aDocument({ id: 'd1', name: 'Manuel d’utilisation', category: 'MANUAL', authorId: 'm2' }),
    aDocumentLink({ id: 'd2', name: 'Catalogue de pièces', category: 'OTHER' }),
  ]);
});

describe('liste du dossier', () => {
  it('affiche fichiers et liens dans la même liste, chacun avec ce qui le décrit', async () => {
    render(<DocumentsPage members={members} currentMemberId="m1" />);
    await screen.findByText('Manuel d’utilisation');

    expect(sousTitre('Manuel d’utilisation')).toBe('Manuel · 4,2 Mo · Bob, 1 mars 2026');
    // Un lien n'a pas de poids : c'est son domaine qui prend la place.
    expect(sousTitre('Catalogue de pièces')).toBe('Autre · kubota-eu.com · Alice, 1 mars 2026');
  });

  // Le contenu d'un fichier est servi par une redirection vers le stockage d'objets : suivre ce
  // lien par `fetch` échouerait sous `connect-src 'self'`, c'est donc bien un lien du navigateur.
  it('ouvre un fichier par l’API et un lien chez son hébergeur', async () => {
    render(<DocumentsPage members={members} currentMemberId="m1" />);
    await screen.findByText('Manuel d’utilisation');

    const fichier = within(ligne('Manuel d’utilisation')).getByRole('link');
    expect(fichier.getAttribute('href')).toBe('/api/documents/d1/content');
    expect(fichier.getAttribute('rel')).toContain('noopener');

    const lien = within(ligne('Catalogue de pièces')).getByRole('link');
    expect(lien.getAttribute('href')).toBe('https://kubota-eu.com/pieces');
  });

  it('filtre par catégorie, et la recherche porte sur le nom comme sur le fichier', async () => {
    const user = userEvent.setup();
    render(<DocumentsPage members={members} currentMemberId="m1" />);
    await screen.findByText('Manuel d’utilisation');

    await user.click(screen.getByRole('button', { name: /^Manuel 1$/ }));
    expect(screen.queryByText('Catalogue de pièces')).toBeNull();

    await user.click(screen.getByRole('button', { name: /^Tous 2$/ }));
    await user.type(screen.getByLabelText('Rechercher un document'), 'manuel.pdf');
    expect(screen.getByText('Manuel d’utilisation')).toBeTruthy();
    expect(screen.queryByText('Catalogue de pièces')).toBeNull();
  });

  it('recharge le dossier au changement d’équipement, filtre remis à zéro', async () => {
    const user = userEvent.setup();
    render(<DocumentsPage members={members} currentMemberId="m1" />);
    await screen.findByText('Manuel d’utilisation');
    await user.click(screen.getByRole('button', { name: /^Manuel 1$/ }));

    stub.listDocuments.mockResolvedValue([]);
    await user.selectOptions(screen.getByLabelText('Équipement'), 'e2');

    expect(await screen.findByText(/Dossier vide/)).toBeTruthy();
    expect(stub.listDocuments).toHaveBeenCalledWith('e2');
  });
});

describe('ajout', () => {
  it('dépose un fichier avec sa catégorie, en proposant le nom du fichier', async () => {
    const user = userEvent.setup();
    render(<DocumentsPage members={members} currentMemberId="m1" />);
    await screen.findByText('Manuel d’utilisation');

    await user.click(screen.getByRole('button', { name: /Déposer un fichier/ }));
    const fichier = new File(['%PDF-1.4'], 'notice-kx027.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText('Fichier à déposer'), fichier);

    // Le nom du fichier est repris comme proposition, et reste modifiable.
    const nom = screen.getByPlaceholderText('ex. Manuel d’utilisation') as HTMLInputElement;
    expect(nom.value).toBe('notice-kx027.pdf');
    await user.clear(nom);
    await user.type(nom, 'Notice constructeur');
    await user.selectOptions(screen.getByLabelText('Catégorie'), 'MAINTENANCE');
    await user.click(screen.getByRole('button', { name: /Ajouter au dossier/ }));

    await waitFor(() =>
      expect(stub.uploadDocument).toHaveBeenCalledWith(fichier, {
        equipmentId: 'e1',
        category: 'MAINTENANCE',
        name: 'Notice constructeur',
      }),
    );
    // Le dossier n'est rechargé qu'après la résolution de l'envoi : attendre, ne pas supposer.
    await waitFor(() => expect(stub.listDocuments).toHaveBeenCalledTimes(2));
  });

  it('ajoute un lien, et bascule entre les deux natures sans fermer la modale', async () => {
    const user = userEvent.setup();
    render(<DocumentsPage members={members} currentMemberId="m1" />);
    await screen.findByText('Manuel d’utilisation');

    await user.click(screen.getByRole('button', { name: /Déposer un fichier/ }));
    await user.click(screen.getByRole('button', { name: /^Lien$/ }));

    await user.type(screen.getByPlaceholderText('https://…'), 'https://exemple.fr/tuto');
    await user.click(screen.getByRole('button', { name: /Ajouter au dossier/ }));

    await waitFor(() =>
      expect(stub.addDocumentLink).toHaveBeenCalledWith({
        equipmentId: 'e1',
        url: 'https://exemple.fr/tuto',
        name: undefined,
        category: 'MANUAL',
      }),
    );
  });

  it('affiche le refus du serveur sans fermer la modale', async () => {
    const user = userEvent.setup();
    stub.addDocumentLink.mockRejectedValue(new Error('Un lien doit commencer par http:// ou https://.'));
    render(<DocumentsPage members={members} currentMemberId="m1" />);
    await screen.findByText('Manuel d’utilisation');

    await user.click(screen.getByRole('button', { name: /Ajouter un lien/ }));
    await user.type(screen.getByPlaceholderText('https://…'), 'javascript:alert(1)');
    await user.click(screen.getByRole('button', { name: /Ajouter au dossier/ }));

    expect(await screen.findByText('Un lien doit commencer par http:// ou https://.')).toBeTruthy();
    expect(screen.getByPlaceholderText('https://…')).toBeTruthy();
  });
});

describe('renommage et suppression', () => {
  // Le dossier appartient au cercle : Alice reclasse un document déposé par Bob.
  it('renomme et reclasse un document déposé par quelqu’un d’autre', async () => {
    const user = userEvent.setup();
    render(<DocumentsPage members={members} currentMemberId="m1" />);
    await screen.findByText('Manuel d’utilisation');

    await user.click(screen.getByRole('button', { name: 'Renommer Manuel d’utilisation' }));
    const nom = screen.getByLabelText('Nom du document');
    await user.clear(nom);
    await user.type(nom, 'Notice Kubota');
    await user.selectOptions(screen.getByLabelText('Catégorie'), 'PURCHASE');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() =>
      expect(stub.updateDocument).toHaveBeenCalledWith('d1', { name: 'Notice Kubota', category: 'PURCHASE' }),
    );
  });

  it('demande confirmation avant de supprimer, et respecte le refus', async () => {
    const user = userEvent.setup();
    const confirmer = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<DocumentsPage members={members} currentMemberId="m1" />);
    await screen.findByText('Manuel d’utilisation');

    await user.click(screen.getByRole('button', { name: 'Supprimer Manuel d’utilisation' }));
    expect(confirmer.mock.calls[0]?.[0]).toContain('Manuel d’utilisation');
    expect(stub.deleteDocument).not.toHaveBeenCalled();

    confirmer.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Supprimer Manuel d’utilisation' }));
    await waitFor(() => expect(stub.deleteDocument).toHaveBeenCalledWith('d1'));
    confirmer.mockRestore();
  });
});

describe('sans équipement partagé', () => {
  it('explique que le dossier suit un équipement', async () => {
    stub.listEquipments.mockResolvedValue([]);
    render(<DocumentsPage members={members} currentMemberId="m1" />);
    expect(await screen.findByText(/Aucun équipement partagé avec vous/)).toBeTruthy();
  });
});
