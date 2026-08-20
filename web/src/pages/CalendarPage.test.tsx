import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ApiModule from '../api';
import { CalendarPage } from './CalendarPage';
import { aMember, anEquipment, aReservation, createApiStub } from '../test/factories';
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
  stub.listEquipments.mockResolvedValue([
    anEquipment({ id: 'e1', name: 'Tracteur', memberIds: ['m1', 'm2'] }),
    anEquipment({ id: 'e2', name: 'Broyeur', memberIds: ['m2'] }),
  ]);
});

function renderPage() {
  return render(<CalendarPage members={members} currentMemberId="m1" onRecordUsage={vi.fn()} />);
}

/** Le formulaire vit en modale : rien n'est saisissable tant qu'elle n'est pas ouverte. */
async function openForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Réserver un créneau' }));
  await screen.findByRole('button', { name: 'Réserver' });
}

/** Renseigne le créneau du formulaire (champs date/heure natifs). */
function fillSlot(slot: { startDate: string; startTime: string; endDate: string; endTime: string }) {
  fireEvent.change(screen.getByLabelText('Date de début'), { target: { value: slot.startDate } });
  fireEvent.change(screen.getByLabelText('Heure de début'), { target: { value: slot.startTime } });
  fireEvent.change(screen.getByLabelText('Date de fin'), { target: { value: slot.endDate } });
  fireEvent.change(screen.getByLabelText('Heure de fin'), { target: { value: slot.endTime } });
}

describe('formulaire de réservation', () => {
  it("réserve le créneau saisi sur l'équipement choisi", async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    fillSlot({ startDate: '2026-03-02', startTime: '08:00', endDate: '2026-03-02', endTime: '12:00' });
    await user.click(screen.getByRole('button', { name: 'Réserver' }));

    await waitFor(() =>
      expect(stub.reserve).toHaveBeenCalledWith(
        expect.objectContaining({
          equipmentId: 'e1',
          start: new Date(2026, 2, 2, 8).toISOString(),
          end: new Date(2026, 2, 2, 12).toISOString(),
          status: 'REQUIRED',
        }),
      ),
    );
  });

  it('ne propose que les équipements de mon cercle', async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);
    const select = screen.getByLabelText('Équipement');

    expect([...(select as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['Tracteur']);
  });

  it('refuse un créneau dont la fin précède le début', async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    fillSlot({ startDate: '2026-03-02', startTime: '12:00', endDate: '2026-03-02', endTime: '08:00' });
    await user.click(screen.getByRole('button', { name: 'Réserver' }));

    expect(await screen.findByText('La fin du créneau doit être après le début.')).toBeDefined();
    expect(stub.reserve).not.toHaveBeenCalled();
  });

  // Le conflit n'est pas bloquant, mais il doit être annoncé avant l'envoi, avec une porte de
  // sortie : le premier créneau libre de même durée.
  it('annonce le chevauchement et décale au prochain créneau libre', async () => {
    const user = userEvent.setup();
    stub.calendar.mockResolvedValue([
      aReservation({
        id: 'r1',
        equipmentId: 'e1',
        memberId: 'm2',
        start: new Date(2026, 2, 2, 8).toISOString(),
        end: new Date(2026, 2, 2, 12).toISOString(),
      }),
    ]);
    renderPage();
    await openForm(user);

    fillSlot({ startDate: '2026-03-02', startTime: '09:00', endDate: '2026-03-02', endTime: '11:00' });

    expect(await screen.findByText(/chevauche 1 réservation/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: /Décaler au prochain créneau libre/ }));

    expect(screen.getByLabelText('Heure de début')).toHaveProperty('value', '12:00');
    expect(screen.getByLabelText('Heure de fin')).toHaveProperty('value', '14:00');
  });

  it('referme le formulaire et confirme une fois le créneau réservé', async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);

    fillSlot({ startDate: '2026-03-02', startTime: '08:00', endDate: '2026-03-02', endTime: '12:00' });
    await user.click(screen.getByRole('button', { name: 'Réserver' }));

    expect(await screen.findByText('Réservation enregistrée.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Réserver' })).toBeNull();
  });

  it('ouvre le formulaire pré-rempli en cliquant sur un jour du calendrier', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: 'Réserver un créneau' });
    const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const expected = `${firstOfMonth.getFullYear()}-${String(firstOfMonth.getMonth() + 1).padStart(2, '0')}-01`;

    await user.click(document.querySelector(`.cal-cell:not(.outside)`) as HTMLElement);

    await screen.findByRole('button', { name: 'Réserver' });
    expect(screen.getByLabelText('Date de début')).toHaveProperty('value', expected);
    expect(screen.getByLabelText('Date de fin')).toHaveProperty('value', expected);
  });
});

describe('ouverture du formulaire', () => {
  it("reste fermé quand on clique la réservation d'un autre membre", async () => {
    const user = userEvent.setup();
    stub.calendar.mockResolvedValue([
      aReservation({
        id: 'r1',
        equipmentId: 'e1',
        memberId: 'm2',
        start: new Date(2026, 2, 2, 8).toISOString(),
        end: new Date(2026, 2, 2, 12).toISOString(),
      }),
    ]);
    renderPage();
    await screen.findByRole('button', { name: 'Réserver un créneau' });

    await user.click(document.querySelector('.cal-event') as HTMLElement);

    expect(screen.queryByRole('button', { name: 'Réserver' })).toBeNull();
  });

  it("attend le chargement des équipements avant d'ouvrir la saisie", () => {
    stub.listEquipments.mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(screen.getByRole('button', { name: 'Réserver un créneau' })).toHaveProperty('disabled', true);
  });

  it('part du premier équipement de mon cercle, pas du premier de la liste', async () => {
    const user = userEvent.setup();
    stub.listEquipments.mockResolvedValue([
      anEquipment({ id: 'e1', name: 'Tracteur', memberIds: ['m2'] }),
      anEquipment({ id: 'e2', name: 'Broyeur', memberIds: ['m1'] }),
    ]);
    renderPage();
    await openForm(user);

    fillSlot({ startDate: '2026-03-02', startTime: '08:00', endDate: '2026-03-02', endTime: '12:00' });
    await user.click(screen.getByRole('button', { name: 'Réserver' }));

    await waitFor(() => expect(stub.reserve).toHaveBeenCalledWith(expect.objectContaining({ equipmentId: 'e2' })));
  });
});

describe('mes réservations', () => {
  it('propose de modifier les miennes, pas celles des autres', async () => {
    const user = userEvent.setup();
    stub.calendar.mockResolvedValue([
      aReservation({
        id: 'r1',
        equipmentId: 'e1',
        memberId: 'm1',
        start: new Date(2026, 2, 2, 8).toISOString(),
        end: new Date(2026, 2, 2, 12).toISOString(),
      }),
      aReservation({
        id: 'r2',
        equipmentId: 'e1',
        memberId: 'm2',
        start: new Date(2026, 2, 3, 8).toISOString(),
        end: new Date(2026, 2, 3, 12).toISOString(),
      }),
    ]);
    renderPage();
    await screen.findByRole('button', { name: 'Réserver un créneau' });

    await user.click(screen.getByRole('button', { name: 'Liste' }));

    expect(screen.getAllByRole('button', { name: 'Modifier' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Modifier' }));
    expect(screen.getByLabelText('Date de début')).toHaveProperty('value', '2026-03-02');
    expect(screen.getByRole('button', { name: 'Enregistrer les modifications' })).toBeDefined();
  });
});
