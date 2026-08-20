import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ApiModule from '../api';
import { MaintenancePage } from './MaintenancePage';
import { aChecklist, aMember, anEquipment, createApiStub } from '../test/factories';
import type { ApiStub } from '../test/factories';

const mocks = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: mocks.api };
});

let stub: ApiStub;

const members = [aMember({ id: 'm1', name: 'Alice' })];
const tracteur = anEquipment({ id: 'e1', name: 'Tracteur', memberIds: ['m1'] });

beforeEach(() => {
  localStorage.clear();
  stub = createApiStub();
  for (const key of Object.keys(mocks.api)) delete mocks.api[key];
  Object.assign(mocks.api, stub);
  stub.listChecklists.mockResolvedValue([aChecklist({ title: 'Avant utilisation' })]);
});

function renderPage(section: 'usage' | 'checklists', onSelectSection = vi.fn()) {
  render(
    <MaintenancePage
      members={members}
      currentMemberId="m1"
      equipment={tracteur}
      section={section}
      onSelectSection={onSelectSection}
    />,
  );
  return onSelectSection;
}

describe('sous-onglets de l’entretien', () => {
  it('montre les relevés et marque la pastille « Relevés » comme active', async () => {
    renderPage('usage');

    // Le bouton flottant est celui des relevés : il porte l'action, pas un « Ajouter » générique.
    expect((await screen.findByRole('button', { name: 'Saisir un relevé' })).classList.contains('fab')).toBe(true);
    expect(screen.getByRole('tab', { name: 'Relevés' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Checklists' }).getAttribute('aria-selected')).toBe('false');
  });

  it('montre les checklists et marque la pastille « Checklists » comme active', async () => {
    renderPage('checklists');

    expect(await screen.findByText('Avant utilisation')).toBeDefined();
    // Chaque section porte son propre bouton flottant : celui des relevés cède la place à celui
    // des checklists, il n'en reste jamais deux.
    expect(screen.queryByRole('button', { name: 'Saisir un relevé' })).toBeNull();
    expect((await screen.findByRole('button', { name: 'Créer une checklist' })).classList.contains('fab')).toBe(true);
    expect(document.querySelectorAll('.fab')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: 'Checklists' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Relevés' }).getAttribute('aria-selected')).toBe('false');
  });

  it('remonte la section demandée au parent, qui la détient', async () => {
    const user = userEvent.setup();
    const onSelectSection = renderPage('usage');

    await user.click(screen.getByRole('tab', { name: 'Checklists' }));

    expect(onSelectSection).toHaveBeenCalledWith('checklists');
  });
});
