import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ApiModule from '../api';
import type { DirectoryMember } from '../api';
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

function renderPage(props: { members?: typeof members; onMemberCreated?: (m: DirectoryMember) => void } = {}) {
  return render(
    <EquipmentsPage
      members={props.members ?? members}
      currentMemberId="m1"
      onMemberCreated={props.onMemberCreated ?? (() => {})}
    />,
  );
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

describe('fiche d’équipement : ce qui est vraiment demandé', () => {
  /** Ouvre le formulaire de création et rend l'utilisateur virtuel qui le remplit. */
  async function ouvrirLeFormulaire() {
    const user = userEvent.setup();
    stub.listEquipments.mockResolvedValue([]);
    renderPage();
    await user.click(await screen.findByRole('button', { name: '+ Ajouter un équipement' }));
    return user;
  }

  it('crée un équipement sans catégorie ni valeur d’achat', async () => {
    // Ces deux champs ne décrivent que la fiche : les exiger n'obtenait qu'une saisie de
    // complaisance avant de pouvoir partager l'équipement.
    const user = await ouvrirLeFormulaire();
    await user.type(screen.getByLabelText(/^Nom/), 'Bétonnière');
    await user.click(screen.getByRole('button', { name: 'Créer' }));

    await waitFor(() => expect(stub.createEquipment).toHaveBeenCalled());
    // Vide vaut absence, jamais 0 € : le serveur distingue les deux, l'affichage aussi.
    expect(stub.createEquipment.mock.calls[0]![0]).toMatchObject({
      name: 'Bétonnière',
      category: null,
      purchaseValueEuros: null,
    });
  });

  it('n’affiche ni catégorie ni valeur absentes sur la carte', async () => {
    stub.listEquipments.mockResolvedValue([
      anEquipment({ id: 'e1', name: 'Bétonnière', category: null, purchaseValueEuros: null }),
    ]);
    renderPage();

    const carte = (await screen.findByText('Bétonnière')).closest('.card')!;
    expect(carte.textContent).toContain('acquis le');
    // Ni séparateur orphelin, ni « 0,00 € » là où rien n'a été saisi.
    expect(carte.textContent).not.toContain('· ·');
    expect(carte.textContent).not.toContain('0,00');
  });

  it('renvoie la valeur d’achat existante à la modification, et sait l’effacer', async () => {
    const user = userEvent.setup();
    stub.listEquipments.mockResolvedValue([anEquipment({ id: 'e1', name: 'Tracteur', purchaseValueEuros: 10000 })]);
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Modifier' }));
    const valeur = screen.getByLabelText(/Valeur d'achat/) as HTMLInputElement;
    expect(valeur.value).toBe('10000');
    await user.clear(valeur);
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => expect(stub.updateEquipment).toHaveBeenCalled());
    expect(stub.updateEquipment.mock.calls[0]![1]).toMatchObject({ purchaseValueEuros: null });
  });
});

describe('cercle : une personne qui n’a pas encore ouvert son compte', () => {
  const enAttente = aMember({ id: 'm3', name: 'Chloé', hasPassword: false });

  it('se coche comme les autres, en disant qu’elle n’a pas encore ouvert son compte', async () => {
    const user = userEvent.setup();
    stub.listEquipments.mockResolvedValue([]);
    renderPage({ members: [...members, enAttente] });

    await user.click(await screen.findByRole('button', { name: '+ Ajouter un équipement' }));
    await user.type(screen.getByLabelText(/^Nom/), 'Bétonnière');
    const case_ = screen.getByRole('checkbox', { name: /Chloé/ }) as HTMLInputElement;
    expect(case_.disabled).toBe(false);
    expect(screen.getByText(/\(en attente\)/)).toBeTruthy();

    await user.click(case_);
    await user.click(screen.getByRole('button', { name: 'Créer' }));
    await waitFor(() => expect(stub.createEquipment).toHaveBeenCalled());
    expect(stub.createEquipment.mock.calls[0]![0]).toMatchObject({ memberIds: ['m1', 'm3'] });
  });

  it('créée depuis le formulaire, elle est remontée à la coque et inscrite au cercle', async () => {
    // Sans la remontée, son nom attendrait la relecture de l'annuaire — servie par le cache du
    // service worker sur un réseau lent — et le cercle afficherait un identifiant brut.
    const user = userEvent.setup();
    const créés: DirectoryMember[] = [];
    stub.listEquipments.mockResolvedValue([]);
    renderPage({ onMemberCreated: (m) => créés.push(m) });

    await user.click(await screen.findByRole('button', { name: '+ Ajouter un équipement' }));
    await user.type(screen.getByLabelText(/^Nom/), 'Bétonnière');
    await user.type(screen.getByLabelText(/Ajouter une personne/), 'Chloé');
    // Entrée dans ce champ créait la personne… en soumettant le formulaire de l'équipement.
    await user.keyboard('{Enter}');

    await waitFor(() => expect(stub.createMember).toHaveBeenCalledWith({ name: 'Chloé' }));
    expect(stub.createEquipment).not.toHaveBeenCalled();
    expect(créés).toEqual([expect.objectContaining({ id: 'm9', hasPassword: false })]);
    // Le code d'invitation n'est pas une donnée d'annuaire : il ne suit pas le membre remonté.
    expect(créés[0]).not.toHaveProperty('inviteCode');

    await user.click(screen.getByRole('button', { name: 'Créer' }));
    await waitFor(() => expect(stub.createEquipment).toHaveBeenCalled());
    expect(stub.createEquipment.mock.calls[0]![0]).toMatchObject({ memberIds: ['m1', 'm9'] });
  });
});
