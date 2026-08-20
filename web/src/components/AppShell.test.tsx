import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import type * as ApiModule from '../api';
import { AppShell } from './AppShell';
import { aMember, anEquipment, createApiStub } from '../test/factories';
import type { ApiStub } from '../test/factories';

/** La coque monte la cloche et le menu utilisateur : le client d'API est remplacé en bloc. */
const mocks = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: mocks.api };
});

let stub: ApiStub;

const equipements = [anEquipment({ id: 'e1', name: 'Tracteur' }), anEquipment({ id: 'e2', name: 'Remorque' })];

beforeEach(() => {
  stub = createApiStub();
  for (const key of Object.keys(mocks.api)) delete mocks.api[key];
  Object.assign(mocks.api, stub);
});

function afficher(over: Partial<ComponentProps<typeof AppShell>> = {}) {
  const props: ComponentProps<typeof AppShell> = {
    equipments: equipements,
    currentEquipmentId: 'e1',
    tab: 'agenda',
    member: aMember(),
    onSelectEquipment: vi.fn(),
    onSelectTab: vi.fn(),
    onOpenOverview: vi.fn(),
    onAddEquipment: vi.fn(),
    onNavigate: vi.fn(),
    onLogout: vi.fn(),
    children: <p>Contenu de l’onglet</p>,
    ...over,
  };
  render(<AppShell {...props} />);
  return props;
}

function barreBasse(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Sections de l’équipement' });
}

/** Ouvre la feuille du sélecteur et rend la boîte de dialogue obtenue. */
async function ouvrirFeuille(user: ReturnType<typeof userEvent.setup>, nomCourant: string): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: nomCourant }));
  return screen.getByRole('dialog');
}

describe('AppShell', () => {
  it('rend les cinq sections dans l’ordre', () => {
    afficher();

    const libelles = within(barreBasse())
      .getAllByRole('button')
      .map((b) => b.textContent);

    expect(libelles).toEqual(['Agenda', 'Entretien', 'Dépenses', 'Forum', 'Documents']);
  });

  it('signale l’onglet courant par aria-current', () => {
    afficher({ tab: 'expenses' });

    const onglets = within(barreBasse()).getAllByRole('button');
    const courants = onglets.filter((b) => b.getAttribute('aria-current') === 'page');

    expect(courants.map((b) => b.textContent)).toEqual(['Dépenses']);
  });

  it('demande le changement de section au clic sur un onglet', async () => {
    const user = userEvent.setup();
    const { onSelectTab } = afficher();

    await user.click(within(barreBasse()).getByRole('button', { name: 'Forum' }));

    expect(onSelectTab).toHaveBeenCalledWith('forum');
  });

  it('rend le contenu de l’onglet courant', () => {
    afficher();

    expect(screen.getByText('Contenu de l’onglet')).toBeTruthy();
  });
});

describe('EquipmentSwitcher', () => {
  it('ouvre la feuille des équipements puis la referme sur Échap', async () => {
    const user = userEvent.setup();
    afficher();

    const feuille = await ouvrirFeuille(user, 'Tracteur');
    expect(within(feuille).getByRole('button', { name: 'Remorque' })).toBeTruthy();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('sélectionne un équipement et referme la feuille', async () => {
    const user = userEvent.setup();
    const { onSelectEquipment } = afficher();

    const feuille = await ouvrirFeuille(user, 'Tracteur');
    await user.click(within(feuille).getByRole('button', { name: 'Remorque' }));

    expect(onSelectEquipment).toHaveBeenCalledWith('e2');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('marque l’équipement courant dans la feuille', async () => {
    const user = userEvent.setup();
    afficher();

    const feuille = await ouvrirFeuille(user, 'Tracteur');

    expect(within(feuille).getByRole('button', { name: 'Tracteur' }).getAttribute('aria-current')).toBe('true');
    expect(within(feuille).getByRole('button', { name: 'Remorque' }).getAttribute('aria-current')).toBeNull();
  });

  it('garde le chevron mais ne liste pas les équipements quand le membre n’en a qu’un', async () => {
    const user = userEvent.setup();
    afficher({ equipments: [equipements[0]] });

    // Rien à choisir, mais le chevron reste : c'est le seul signe que le titre est un bouton,
    // et la feuille porte encore la vue d'ensemble et l'ajout d'équipement.
    expect(document.querySelector('.switcher svg')).not.toBeNull();

    const feuille = await ouvrirFeuille(user, 'Tracteur');

    expect(within(feuille).queryByRole('button', { name: 'Tracteur' })).toBeNull();
    expect(within(feuille).getByRole('button', { name: 'Vue d’ensemble' })).toBeTruthy();
  });

  it('ouvre la vue d’ensemble depuis la feuille', async () => {
    const user = userEvent.setup();
    const { onOpenOverview } = afficher();

    const feuille = await ouvrirFeuille(user, 'Tracteur');
    await user.click(within(feuille).getByRole('button', { name: 'Vue d’ensemble' }));

    expect(onOpenOverview).toHaveBeenCalled();
  });

  it('demande l’ajout d’un équipement depuis la feuille', async () => {
    const user = userEvent.setup();
    const { onAddEquipment } = afficher();

    const feuille = await ouvrirFeuille(user, 'Tracteur');
    await user.click(within(feuille).getByRole('button', { name: 'Ajouter un équipement' }));

    expect(onAddEquipment).toHaveBeenCalled();
  });
});
