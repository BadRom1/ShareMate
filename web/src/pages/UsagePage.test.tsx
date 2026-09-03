import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ApiModule from '../api';
import { UsagePage } from './UsagePage';
import { aMaintenanceStatus, aMember, aUsageRecord, anEquipment, createApiStub } from '../test/factories';
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
  stub.maintenanceStatus.mockResolvedValue(aMaintenanceStatus({ currentReading: 100 }));
});

function renderPage(equipment = tracteur) {
  return render(<UsagePage members={members} currentMemberId="m1" equipment={equipment} />);
}

/**
 * La saisie vit en modale : rien n'est renseignable tant qu'elle n'est pas ouverte, et le seul
 * déclencheur est le bouton flottant — un bouton ordinaire remis dans le flux ferait échouer ici.
 */
async function openForm(user: ReturnType<typeof userEvent.setup>) {
  const fab = await screen.findByRole('button', { name: 'Saisir un relevé' });
  expect(fab.classList.contains('fab')).toBe(true);
  await user.click(fab);
  await screen.findByRole('button', { name: 'Enregistrer le relevé' });
}

describe('historique', () => {
  it('montre les relevés sans le formulaire de saisie', async () => {
    stub.usageByEquipment.mockResolvedValue([aUsageRecord({ meterReading: 120, duration: 4 })]);
    renderPage();

    expect(await screen.findByText('120')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Enregistrer le relevé' })).toBeNull();
  });

  it('affiche les décimales à la française, sans artefact de calcul flottant', async () => {
    stub.usageByEquipment.mockResolvedValue([
      aUsageRecord({ meterReading: 165.3, duration: 165.3 - 164, fuelAddedLiters: 12.5 }),
    ]);
    stub.maintenanceStatus.mockResolvedValue(
      aMaintenanceStatus({ currentReading: 165.3, unitsSinceMaintenance: 165.3 - 164, threshold: 10 }),
    );
    renderPage();

    expect(await screen.findByText('1,3 h')).toBeDefined();
    expect(screen.getByText('165,3')).toBeDefined();
    expect(screen.getByText('12,5 L')).toBeDefined();
    expect(screen.getByText(/165,3 h — 1,3\/10 depuis la dernière maintenance/)).toBeDefined();
  });

  it("recharge l'historique quand l'équipement de l'espace change", async () => {
    const { rerender } = renderPage();
    await waitFor(() => expect(stub.usageByEquipment).toHaveBeenCalledWith('e1'));

    rerender(<UsagePage members={members} currentMemberId="m1" equipment={broyeur} />);

    await waitFor(() => expect(stub.usageByEquipment).toHaveBeenCalledWith('e2'));
    expect(stub.maintenanceStatus).toHaveBeenCalledWith('e2');
  });

  it("ne garde que les relevés de l'équipement courant dans la vue par membre", async () => {
    const user = userEvent.setup();
    stub.usageByMember.mockResolvedValue([
      aUsageRecord({ id: 'u1', equipmentId: 'e1', meterReading: 120 }),
      aUsageRecord({ id: 'u2', equipmentId: 'e2', meterReading: 340 }),
    ]);
    renderPage();
    await screen.findByRole('button', { name: 'Saisir un relevé' });

    await user.click(screen.getByLabelText('Mes relevés uniquement'));

    expect(await screen.findByText('120')).toBeDefined();
    expect(screen.queryByText('340')).toBeNull();
  });
});

describe('saisie du relevé', () => {
  it('enregistre la durée saisie et referme la modale', async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    await user.type(screen.getByLabelText(/Durée d'utilisation/), '5');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le relevé' }));

    await waitFor(() =>
      expect(stub.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ equipmentId: 'e1', duration: 5 })),
    );
    expect(await screen.findByText('Relevé enregistré.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Enregistrer le relevé' })).toBeNull();
  });

  // Le changement d'équipement remet la page à neuf par le remontage décidé dans `App` (`key`) :
  // ce qui reste ici, c'est la bascule de l'historique, qui ne démonte rien.
  it('accepte la virgule du clavier français et convertit en compteur total', async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    await user.type(screen.getByLabelText(/Durée d'utilisation/), '1,3');

    expect(screen.getByLabelText(/Compteur total/)).toHaveProperty('value', '101,3');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le relevé' }));

    await waitFor(() =>
      expect(stub.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ equipmentId: 'e1', duration: 1.3 })),
    );
  });

  it('un compteur sous le dernier relevé laisse la durée modifiable et le dit', async () => {
    const user = userEvent.setup();
    stub.maintenanceStatus.mockResolvedValue(aMaintenanceStatus({ currentReading: 164 }));
    renderPage();
    await openForm(user);

    const compteur = screen.getByLabelText(/Compteur total/);
    await user.clear(compteur);
    await user.type(compteur, '100');

    // Une durée négative (100 − 164) bloquerait le champ, qui n'accepte que des nombres positifs.
    const duree = screen.getByLabelText(/Durée d'utilisation/);
    expect(duree).toHaveProperty('value', '');
    expect(screen.getByText(/Un compteur ne recule pas/)).toBeDefined();

    await user.type(duree, '5');
    expect(duree).toHaveProperty('value', '5');
    expect(compteur).toHaveProperty('value', '169');
  });

  it('ignore les frappes qui ne font pas un nombre', async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    const duree = screen.getByLabelText(/Durée d'utilisation/);
    await user.type(duree, '1,3,5abc');

    expect(duree).toHaveProperty('value', '1,35');
  });

  it("retire la confirmation dès qu'on bascule l'historique", async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    await user.type(screen.getByLabelText(/Durée d'utilisation/), '5');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le relevé' }));
    expect(await screen.findByText('Relevé enregistré.')).toBeDefined();

    await user.click(screen.getByLabelText('Mes relevés uniquement'));

    expect(screen.queryByText('Relevé enregistré.')).toBeNull();
  });

  it('préremplit le compteur total avec le dernier relevé connu', async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    expect(screen.getByLabelText(/Compteur total/)).toHaveProperty('value', '100');
  });

  it('laisse la modale ouverte et affiche le refus du serveur', async () => {
    const user = userEvent.setup();
    stub.recordUsage.mockRejectedValue(new Error('Le relevé doit être supérieur au précédent.'));
    renderPage();
    await openForm(user);

    await user.type(screen.getByLabelText(/Durée d'utilisation/), '5');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le relevé' }));

    expect(await screen.findByText('Le relevé doit être supérieur au précédent.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Enregistrer le relevé' })).toBeDefined();
  });
});

describe('trou d’utilisation', () => {
  it('un départ au-dessus du dernier relevé annonce l’écart et demande à qui il est', async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    const depart = screen.getByLabelText(/Compteur au départ/);
    await user.clear(depart);
    await user.type(depart, '158');
    await user.type(screen.getByLabelText(/Durée d'utilisation/), '7');

    expect(screen.getByText(/58 h ont tourné entre le dernier relevé/)).toBeDefined();
    await user.selectOptions(screen.getByLabelText(/À qui sont ces/), 'm2');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le relevé' }));

    await waitFor(() =>
      expect(stub.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ startReading: 158, duration: 7, gapMemberId: 'm2' }),
      ),
    );
  });

  it('sans écart, aucune question n’est posée et le départ n’est pas imposé au serveur', async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    await user.type(screen.getByLabelText(/Durée d'utilisation/), '5');
    expect(screen.queryByLabelText(/À qui sont ces/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Enregistrer le relevé' }));

    await waitFor(() => expect(stub.recordUsage).toHaveBeenCalled());
    // Le départ prérempli vient d'un historique qui a pu vieillir : ne pas l'envoyer laisse le
    // serveur partir de son dernier relevé, au lieu de refuser la saisie sur une valeur périmée.
    const [envoyé] = stub.recordUsage.mock.calls[0]!;
    expect(envoyé).not.toHaveProperty('startReading');
    expect(envoyé).toMatchObject({ duration: 5, gapMemberId: null });
  });

  it('un relevé posé par un autre membre entre-temps ne fait pas échouer la saisie', async () => {
    const user = userEvent.setup();
    // L'écran affiche encore 100 h ; le serveur, lui, en est à 165 depuis la saisie d'un autre,
    // et refuse tout départ sous son dernier relevé — comme le fait le vrai serveur.
    stub.recordUsage.mockImplementation(async (input: unknown) => {
      const { startReading } = input as { startReading?: number };
      if (startReading !== undefined && startReading < 165) {
        throw new Error(
          `Le compteur au départ (${startReading}) ne peut pas être inférieur au dernier relevé connu (165).`,
        );
      }
      return { ...aUsageRecord(), gap: null };
    });
    renderPage();
    await openForm(user);

    await user.type(screen.getByLabelText(/Durée d'utilisation/), '5');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le relevé' }));

    expect(await screen.findByText('Relevé enregistré.')).toBeDefined();
  });

  it('annonce les heures laissées en attente par la saisie', async () => {
    const user = userEvent.setup();
    stub.recordUsage.mockResolvedValue({
      ...aUsageRecord({ meterReading: 165, startReading: 158, duration: 7 }),
      gap: aUsageRecord({ id: 'u9', memberId: null, meterReading: 158, startReading: 100, duration: 58 }),
    });
    renderPage();
    await openForm(user);

    await user.type(screen.getByLabelText(/Durée d'utilisation/), '7');
    await user.click(screen.getByRole('button', { name: 'Enregistrer le relevé' }));

    expect(await screen.findByText(/58 h restent en attente d'attribution/)).toBeDefined();
  });

  it('n’offre pas de supprimer des heures en attente que le compteur atteste', async () => {
    stub.usageByEquipment.mockResolvedValue([
      aUsageRecord({ id: 'u9', memberId: null, meterReading: 58, startReading: 0, duration: 58 }),
    ]);
    renderPage();

    expect(await screen.findByRole('button', { name: "C'était moi" })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Supprimer' })).toBeNull();
  });

  it('signale les heures en attente et les reprend d’un geste', async () => {
    const user = userEvent.setup();
    stub.usageByEquipment.mockResolvedValue([
      aUsageRecord({ id: 'u9', memberId: null, meterReading: 158, startReading: 100, duration: 58 }),
    ]);
    renderPage();

    expect(await screen.findByText(/58 h en attente d'attribution/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: "C'était moi" }));

    await waitFor(() => expect(stub.updateUsage).toHaveBeenCalledWith('u9', { memberId: 'm1' }));
    expect(await screen.findByText('Relevé attribué.')).toBeDefined();
  });
});

describe('correction et suppression', () => {
  beforeEach(() => {
    stub.usageByEquipment.mockResolvedValue([
      aUsageRecord({ id: 'u1', memberId: 'm1', meterReading: 120, startReading: 100, duration: 20 }),
    ]);
    // Un relevé plus haut existe : la suppression laissera donc ses heures en attente.
    stub.maintenanceStatus.mockResolvedValue(aMaintenanceStatus({ currentReading: 160 }));
  });

  it('corrige le compteur et réattribue le relevé', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Modifier' }));
    const compteur = screen.getByLabelText(/Compteur total/);
    expect(compteur).toHaveProperty('value', '120');
    await user.clear(compteur);
    await user.type(compteur, '115');
    await user.selectOptions(screen.getByLabelText('Attribué à'), 'm2');
    await user.click(screen.getByRole('button', { name: 'Enregistrer la correction' }));

    await waitFor(() =>
      expect(stub.updateUsage).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ meterReading: 115, startReading: 100, memberId: 'm2' }),
      ),
    );
    expect(await screen.findByText('Relevé corrigé.')).toBeDefined();
  });

  it('remet un relevé en attente d’attribution', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Modifier' }));
    await user.selectOptions(screen.getByLabelText('Attribué à'), '');
    await user.click(screen.getByRole('button', { name: 'Enregistrer la correction' }));

    await waitFor(() =>
      expect(stub.updateUsage).toHaveBeenCalledWith('u1', expect.objectContaining({ memberId: null })),
    );
  });

  it('ne supprime qu’après confirmation, en disant ce que deviennent les heures', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Supprimer' }));
    expect(screen.getByText(/ses heures restent en attente d.attribution/)).toBeDefined();
    expect(stub.deleteUsage).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Supprimer le relevé' }));
    await waitFor(() => expect(stub.deleteUsage).toHaveBeenCalledWith('u1'));
    expect(await screen.findByText('Relevé supprimé.')).toBeDefined();
  });
});
