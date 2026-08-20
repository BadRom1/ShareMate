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
const tracteur = anEquipment({ id: 'e1', name: 'Tracteur', memberIds: ['m1', 'm2'] });
/** Équipement hors de mon cercle : l'agenda reste consultable, la réservation non. */
const broyeur = anEquipment({ id: 'e2', name: 'Broyeur', memberIds: ['m2'] });

beforeEach(() => {
  stub = createApiStub();
  for (const key of Object.keys(mocks.api)) delete mocks.api[key];
  Object.assign(mocks.api, stub);
});

function renderPage(equipment = tracteur) {
  return render(<CalendarPage members={members} currentMemberId="m1" equipment={equipment} onRecordUsage={vi.fn()} />);
}

/** Le formulaire vit en modale : rien n'est saisissable tant qu'elle n'est pas ouverte. */
async function openForm(user: ReturnType<typeof userEvent.setup>) {
  // La saisie s'ouvre par le bouton flottant, et par lui seul : une régression qui remettrait un
  // bouton ordinaire dans le flux de la page doit échouer ici, pas passer inaperçue.
  const declencheurs = await screen.findAllByRole('button', { name: 'Réserver un créneau' });
  expect(declencheurs).toHaveLength(1);
  expect(declencheurs[0].classList.contains('fab')).toBe(true);
  await user.click(declencheurs[0]);
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
  it("réserve le créneau saisi sur l'équipement de l'espace courant", async () => {
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

  it('refuse la saisie sur un équipement dont je ne fais pas partie du cercle', async () => {
    const user = userEvent.setup();
    renderPage(broyeur);

    await user.click(await screen.findByRole('button', { name: 'Réserver un créneau' }));

    expect(await screen.findByText(/Vous ne faites pas partie du cercle de cet équipement/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Réserver' })).toBeNull();
  });
});

describe('équipement de l’espace de travail', () => {
  it('ne montre que les réservations de l’équipement courant', async () => {
    const user = userEvent.setup();
    stub.calendar.mockResolvedValue([
      aReservation({ id: 'r1', equipmentId: 'e1', memberId: 'm2' }),
      aReservation({ id: 'r2', equipmentId: 'e2', memberId: 'm2' }),
    ]);
    renderPage();
    await screen.findByRole('button', { name: 'Réserver un créneau' });

    await user.click(screen.getByRole('button', { name: 'Liste' }));

    expect(document.querySelectorAll('.reservation-item')).toHaveLength(1);
  });

  it('recharge l’agenda quand l’équipement de l’espace change', async () => {
    const user = userEvent.setup();
    stub.calendar.mockResolvedValue([aReservation({ id: 'r1', equipmentId: 'e1', notes: 'Tranchée jardin' })]);
    const { rerender } = renderPage();
    await screen.findByRole('button', { name: 'Réserver un créneau' });
    await user.click(screen.getByRole('button', { name: 'Liste' }));
    expect(screen.getByText('Tranchée jardin')).toBeDefined();

    stub.calendar.mockResolvedValue([aReservation({ id: 'r2', equipmentId: 'e2', notes: 'Broyage haie' })]);
    rerender(<CalendarPage members={members} currentMemberId="m1" equipment={broyeur} onRecordUsage={vi.fn()} />);

    expect(await screen.findByText('Broyage haie')).toBeDefined();
    expect(screen.queryByText('Tranchée jardin')).toBeNull();
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

describe('clé de lecture de la grille', () => {
  // La légende visible a été retirée et le code visuel (bordure, trame, point rouge) ne se lit
  // plus qu'à l'œil ou au survol : sans ce texte, il n'est décodable ni au clavier ni à l'oreille.
  it("annonce le code visuel aux lecteurs d'écran, sur les deux grilles", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: 'Réserver un créneau' });

    const cle = /bordure pleine.+hachuré.+point rouge/i;
    expect(screen.getByText(cle).classList.contains('visually-hidden')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Semaine' }));

    expect(screen.getByText(cle).classList.contains('visually-hidden')).toBe(true);
  });
});

describe('cadrage en hauteur des grilles', () => {
  // Les deux grilles se cadrent sur la hauteur visible : sans `cal-card`, la carte reprend sa
  // hauteur naturelle et la grille redevient plus haute que l'écran, colonnes étirées comprises.
  // La vue liste, elle, n'a rien à étirer — la classe doit disparaître avec elle.
  it('marque la carte des grilles, pas celle de la liste', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: 'Réserver un créneau' });

    const carte = () => document.querySelector('.cal-page > .card') as HTMLElement;
    expect(carte().classList.contains('cal-card')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Semaine' }));
    expect(carte().classList.contains('cal-card')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Liste' }));
    expect(carte().classList.contains('cal-card')).toBe(false);
  });
});

describe('en-tête de la vue semaine', () => {
  // Le jour et le quantième sur deux lignes : à 320 px, « lun. 17 » d'un seul tenant rognait.
  it('sépare le jour du quantième dans chaque colonne', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: 'Réserver un créneau' });

    await user.click(screen.getByRole('button', { name: 'Semaine' }));

    // Les sept jours ; l'en-tête vide de la colonne des heures n'en est pas une.
    const entetes = document.querySelectorAll('.week-day-col .week-head');
    expect(entetes).toHaveLength(7);
    for (const entete of entetes) {
      expect(entete.querySelector('.week-head-day')?.textContent?.trim()).toMatch(/^[a-zéû]+\.$/);
      expect(entete.querySelector('.week-head-date')?.textContent?.trim()).toMatch(/^\d{1,2}$/);
    }
  });
});
