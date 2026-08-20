import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ApiModule from '../api';
import { OverviewPanel } from './OverviewPanel';
import { aMaintenanceStatus, aMember, aReservation, anEquipment, createApiStub } from '../test/factories';
import type { ApiStub } from '../test/factories';

const mocks = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: mocks.api };
});

let stub: ApiStub;

const equipements = [
  anEquipment({ id: 'e1', name: 'Tracteur' }),
  anEquipment({ id: 'e2', name: 'Remorque', meterUnit: 'KILOMETERS' }),
];
const membres = [aMember({ id: 'm1', name: 'Alice' }), aMember({ id: 'm2', name: 'Bob' })];

/** Date décalée de `heures` par rapport à maintenant : « Ma semaine » ne montre que l'à-venir proche. */
function dans(heures: number): string {
  return new Date(Date.now() + heures * 3_600_000).toISOString();
}

beforeEach(() => {
  stub = createApiStub();
  for (const key of Object.keys(mocks.api)) delete mocks.api[key];
  Object.assign(mocks.api, stub);
});

function afficher(onOpenEquipment = vi.fn(), onClose = vi.fn()) {
  render(
    <OverviewPanel
      equipments={equipements}
      members={membres}
      currentMemberId="m1"
      onOpenEquipment={onOpenEquipment}
      onClose={onClose}
    />,
  );
  return { onOpenEquipment, onClose };
}

/** Carte d'une section, repérée par son titre. */
function section(titre: string): HTMLElement {
  const carte = screen.getByRole('heading', { name: titre }).closest('section');
  if (!carte) throw new Error(`Aucune section « ${titre} »`);
  return carte;
}

describe('OverviewPanel', () => {
  it('liste les réservations à venir du membre, tous équipements confondus', async () => {
    stub.calendar.mockResolvedValue([
      aReservation({ id: 'r1', equipmentId: 'e1', memberId: 'm1', start: dans(24), end: dans(26) }),
      aReservation({ id: 'r2', equipmentId: 'e2', memberId: 'm1', start: dans(48), end: dans(50) }),
      aReservation({ id: 'r3', equipmentId: 'e1', memberId: 'm2', start: dans(3), end: dans(4) }),
    ]);
    afficher();

    const lignes = (await within(section('Ma semaine')).findAllByRole('button')).map((b) => b.textContent);

    expect(lignes).toHaveLength(2);
    expect(lignes[0]).toContain('Tracteur');
    expect(lignes[1]).toContain('Remorque');
  });

  it('ouvre l’agenda de l’équipement au clic sur une réservation', async () => {
    const user = userEvent.setup();
    stub.calendar.mockResolvedValue([
      aReservation({ id: 'r1', equipmentId: 'e2', memberId: 'm1', start: dans(24), end: dans(26) }),
    ]);
    const { onOpenEquipment } = afficher();

    await user.click(await within(section('Ma semaine')).findByRole('button'));

    expect(onOpenEquipment).toHaveBeenCalledWith('e2', 'agenda');
  });

  it('ne retient que les alertes d’entretien actives', async () => {
    stub.alerts.mockResolvedValue([
      aMaintenanceStatus({ equipmentId: 'e1', alert: false }),
      aMaintenanceStatus({ equipmentId: 'e2', alert: true, unitsSinceMaintenance: 55 }),
    ]);
    afficher();

    const carte = section('À faire');
    const ligne = await within(carte).findByRole('button');

    expect(ligne.textContent).toContain('Remorque');
    expect(ligne.textContent).toContain('55 km depuis le dernier entretien');
  });

  it('ouvre l’entretien de l’équipement au clic sur une alerte', async () => {
    const user = userEvent.setup();
    stub.alerts.mockResolvedValue([aMaintenanceStatus({ equipmentId: 'e1', alert: true })]);
    const { onOpenEquipment } = afficher();

    await user.click(await within(section('À faire')).findByRole('button'));

    expect(onOpenEquipment).toHaveBeenCalledWith('e1', 'maintenance');
  });

  it('affiche un solde par équipement, sans jamais les additionner', async () => {
    stub.balances.mockImplementation(async (equipmentId: string) =>
      equipmentId === 'e1'
        ? [{ memberId: 'm1', balanceEuros: 30 }]
        : [
            { memberId: 'm1', balanceEuros: -12 },
            { memberId: 'm2', balanceEuros: 12 },
          ],
    );
    afficher();

    const carte = section('Mes soldes');
    const soldes = await within(carte).findAllByRole('button');

    expect(soldes).toHaveLength(2);
    expect(soldes[0].textContent).toContain('Tracteur');
    expect(soldes[0].textContent).toContain('30,00');
    expect(soldes[1].textContent).toContain('Remorque');
    expect(soldes[1].textContent).toContain('-12,00');
    // Le total (18 €) n'existe pas : une dette se règle équipement par équipement.
    expect(within(carte).queryByText(/18,00/)).toBeNull();
    expect(stub.balances).toHaveBeenCalledTimes(2);
  });

  it('ouvre les dépenses de l’équipement au clic sur un solde', async () => {
    const user = userEvent.setup();
    stub.balances.mockResolvedValue([{ memberId: 'm1', balanceEuros: 30 }]);
    const { onOpenEquipment } = afficher();

    const soldes = await within(section('Mes soldes')).findAllByRole('button');
    await user.click(soldes[1]);

    expect(onOpenEquipment).toHaveBeenCalledWith('e2', 'expenses');
  });

  it('annonce les sections vides plutôt qu’une carte muette', async () => {
    afficher();

    expect(await within(section('Ma semaine')).findByText('Aucune réservation cette semaine.')).toBeTruthy();
    expect(within(section('À faire')).getByText('Aucun entretien en attente.')).toBeTruthy();
  });

  it('se ferme au bouton et sur Échap', async () => {
    const user = userEvent.setup();
    const { onClose } = afficher();

    await user.click(screen.getByRole('button', { name: 'Fermer' }));
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
