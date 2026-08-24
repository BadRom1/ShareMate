import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ApiModule from '../api';
import { AdminPage } from './AdminPage';
import { aMember, createApiStub, noMergeCounts } from '../test/factories';
import type { ApiStub } from '../test/factories';

const mocks = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: mocks.api };
});

let stub: ApiStub;

/** Le cas de l'issue : deux Damien, l'ancien porte l'historique, le nouveau l'accès qui marche. */
const alice = aMember({ id: 'alice', name: 'Alice', isAdmin: true });
const ancien = aMember({ id: 'ancien', name: 'Damien', email: 'damien@example.org' });
const nouveau = aMember({ id: 'nouveau', name: 'Damien' });

beforeEach(() => {
  stub = createApiStub();
  for (const key of Object.keys(mocks.api)) delete mocks.api[key];
  Object.assign(mocks.api, stub);
  stub.adminMembers.mockResolvedValue([alice, ancien, nouveau]);
  stub.mergePreview.mockResolvedValue(
    noMergeCounts({ circles: 2, circlesMerged: 1, expenseSplits: 3, sessionsRevoked: 1 }),
  );
});

/** Écran monté, annuaire chargé. */
async function afficher() {
  render(<AdminPage currentMemberId="alice" />);
  await screen.findByText(/Tous les comptes/);
}

/** Choisit le couple de comptes et attend l'aperçu. */
async function choisirLeCouple() {
  await userEvent.selectOptions(screen.getByLabelText(/Compte absorbé/), 'ancien');
  await userEvent.selectOptions(screen.getByLabelText(/Compte conservé/), 'nouveau');
  await screen.findByText(/3 répartitions de dépense/);
}

describe('Écran d’administration', () => {
  it('montre tous les comptes, ceux que l’annuaire cadré ne montre plus compris', async () => {
    await afficher();
    expect(stub.adminMembers).toHaveBeenCalled();
    expect(screen.getByText(/Tous les comptes \(3\)/)).toBeTruthy();
    // Deux homonymes : ce qui les distingue est affiché, sinon on ne saurait pas lequel absorber.
    expect(screen.getAllByText(/Damien — damien@example.org/).length).toBeGreaterThan(0);
  });

  it('ne propose jamais d’absorber l’administrateur', async () => {
    await afficher();
    const absorbé = screen.getByLabelText(/Compte absorbé/) as HTMLSelectElement;
    const proposés = [...absorbé.options].map((o) => o.value).filter(Boolean);
    expect(proposés).toEqual(['ancien', 'nouveau']);
    // Il reste choisissable comme compte conservé.
    const conservé = screen.getByLabelText(/Compte conservé/) as HTMLSelectElement;
    expect([...conservé.options].map((o) => o.value)).toContain('alice');
  });

  it('annonce ce qui sera déplacé avant toute confirmation', async () => {
    await afficher();
    await choisirLeCouple();

    expect(stub.mergePreview).toHaveBeenCalledWith('ancien', 'nouveau');
    expect(screen.getByText(/2 cercles d’équipement/)).toBeTruthy();
    expect(screen.getByText(/1 cercle où les deux comptes figuraient/)).toBeTruthy();
    expect(screen.getByText(/1 session révoquée/)).toBeTruthy();
    // Rien n'est parti : l'aperçu est une lecture.
    expect(stub.mergeMembers).not.toHaveBeenCalled();
  });

  it('laisse choisir le nom et l’email champ par champ', async () => {
    await afficher();
    await choisirLeCouple();

    // Par défaut, l'identité du compte conservé : ici, sans email.
    await userEvent.selectOptions(screen.getByLabelText('Email'), 'absorbed');

    await userEvent.click(screen.getByRole('button', { name: /Réunir ces deux comptes/ }));
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: /Réunir définitivement/ }));

    await waitFor(() =>
      expect(stub.mergeMembers).toHaveBeenCalledWith({
        absorbedId: 'ancien',
        keptId: 'nouveau',
        name: 'Damien',
        email: 'damien@example.org',
      }),
    );
  });

  it('demande confirmation en disant ce que le geste emporte, et ne fusionne pas si on annule', async () => {
    await afficher();
    await choisirLeCouple();
    await userEvent.click(screen.getByRole('button', { name: /Réunir ces deux comptes/ }));

    const boîte = await screen.findByRole('alertdialog');
    expect(boîte.textContent).toContain('Absorber « Damien » dans « Damien » ?');
    expect(boîte.textContent).toContain('sera déconnecté');
    expect(boîte.textContent).toContain('Rien ne défait ce geste');

    await userEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(stub.mergeMembers).not.toHaveBeenCalled();
  });

  it('rend compte de la fusion faite et relit l’annuaire', async () => {
    stub.mergeMembers.mockResolvedValue({
      member: aMember({ id: 'nouveau', name: 'Damien' }),
      counts: noMergeCounts({ expenseSplits: 3, sessionsRevoked: 1 }),
    });
    await afficher();
    await choisirLeCouple();
    await userEvent.click(screen.getByRole('button', { name: /Réunir ces deux comptes/ }));
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: /Réunir définitivement/ }));

    await screen.findByText(/Comptes réunis sous « Damien »/);
    expect(screen.getByText(/3 répartitions de dépense/)).toBeTruthy();
    expect(stub.adminMembers).toHaveBeenCalledTimes(2);
  });

  it('affiche le refus du serveur sans rien prétendre avoir fait', async () => {
    stub.mergeMembers.mockRejectedValue(new Error('Cette adresse email est déjà utilisée par un autre membre.'));
    await afficher();
    await choisirLeCouple();
    await userEvent.click(screen.getByRole('button', { name: /Réunir ces deux comptes/ }));
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: /Réunir définitivement/ }));

    await screen.findByText('Cette adresse email est déjà utilisée par un autre membre.');
    expect(screen.queryByText(/Comptes réunis/)).toBeNull();
  });
});
