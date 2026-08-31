import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MaintenanceSection, Tab } from '../navigation';
import { ÉTAPES, Tour, marquerVisiteFaite, visiteDéjàFaite } from './Tour';

/**
 * La visite ne parle à aucune API : elle pose des bulles sur la coque et demande les onglets
 * qu'elle décrit. jsdom n'ayant pas de mise en page, toutes les cibles y sont introuvables —
 * ce qui tombe bien, c'est exactement le cas nominal du tout premier lancement, sans équipement.
 */

function afficher() {
  const onSelectTab = vi.fn<(tab: Tab, section?: MaintenanceSection) => void>();
  const onClose = vi.fn();
  const rendu = render(<Tour onSelectTab={onSelectTab} onClose={onClose} />);
  return { onSelectTab, onClose, rendu };
}

function bulle(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Visite guidée' });
}

async function suivant(utilisateur: ReturnType<typeof userEvent.setup>) {
  await utilisateur.click(screen.getByRole('button', { name: 'Suivant' }));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('visite guidée', () => {
  it('ouvre sur la première étape en annonçant le chemin restant', () => {
    afficher();

    expect(bulle()).toBeTruthy();
    expect(screen.getByText(`1 / ${ÉTAPES.length}`)).toBeTruthy();
    expect(screen.getByRole('heading', { name: ÉTAPES[0].titre })).toBeTruthy();
  });

  it('couvre les six gestes du quotidien, dans l’ordre, et jamais l’invitation d’un membre', async () => {
    const utilisateur = userEvent.setup();
    const { onSelectTab } = afficher();

    for (let rang = 1; rang < ÉTAPES.length; rang++) {
      await suivant(utilisateur);
      expect(screen.getByRole('heading', { name: ÉTAPES[rang].titre })).toBeTruthy();
      expect(screen.getByText(`${rang + 1} / ${ÉTAPES.length}`)).toBeTruthy();
    }

    // Les onglets demandés disent l'ordre des gestes mieux que les titres.
    expect(onSelectTab.mock.calls).toEqual([
      ['agenda', undefined],
      ['maintenance', 'usage'],
      ['expenses', undefined],
      ['expenses', undefined],
      ['forum', undefined],
    ]);
    // Inviter quelqu'un n'est pas un geste du quotidien : la visite n'en parle pas.
    const texte = ÉTAPES.map((é) => `${é.titre} ${é.corps}`).join(' ');
    expect(texte).not.toMatch(/invit/i);
  });

  it('ouvre la sous-section des relevés, et pas seulement l’onglet Machine', async () => {
    const utilisateur = userEvent.setup();
    const { onSelectTab } = afficher();

    await suivant(utilisateur);
    await suivant(utilisateur);

    expect(onSelectTab).toHaveBeenLastCalledWith('maintenance', 'usage');
  });

  it('revient à l’étape précédente sans redemander d’onglet en avant', async () => {
    const utilisateur = userEvent.setup();
    afficher();

    await suivant(utilisateur);
    await utilisateur.click(screen.getByRole('button', { name: 'Précédent' }));

    expect(screen.getByText(`1 / ${ÉTAPES.length}`)).toBeTruthy();
    // Rien à quitter sur la première étape : le retour ne propose pas d'aller plus en arrière.
    expect(screen.queryByRole('button', { name: 'Précédent' })).toBeNull();
  });

  it('propose de terminer à la dernière étape, et plus de continuer', async () => {
    const utilisateur = userEvent.setup();
    const { onClose } = afficher();

    for (let rang = 1; rang < ÉTAPES.length; rang++) await suivant(utilisateur);
    expect(screen.queryByRole('button', { name: 'Suivant' })).toBeNull();
    await utilisateur.click(screen.getByRole('button', { name: 'Terminer' }));

    expect(onClose).toHaveBeenCalled();
  });

  it('se laisse passer', async () => {
    const utilisateur = userEvent.setup();
    const { onClose } = afficher();

    await utilisateur.click(screen.getByRole('button', { name: 'Passer' }));

    expect(onClose).toHaveBeenCalled();
  });

  it('se ferme à la touche Échap', async () => {
    const utilisateur = userEvent.setup();
    const { onClose } = afficher();

    await utilisateur.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });

  it('centre la bulle sans halo quand la cible n’existe pas encore — le cas du parc vide', async () => {
    afficher();

    // Aucun élément `data-tour` dans le document : la visite reste lisible, sans rien désigner.
    await waitFor(() => expect(bulle().classList.contains('tour-bubble-centre')).toBe(true));
    expect(document.querySelector('.tour-halo')).toBeNull();
  });

  it('désigne la cible quand la coque la porte', async () => {
    const cible = document.createElement('button');
    cible.setAttribute('data-tour', ÉTAPES[0].cible!);
    // jsdom ne calcule aucune mise en page : la géométrie est dictée à la main.
    cible.getBoundingClientRect = () =>
      ({ top: 10, left: 10, bottom: 50, right: 200, width: 190, height: 40 }) as DOMRect;
    document.body.append(cible);

    afficher();

    await waitFor(() => expect(document.querySelector('.tour-halo')).not.toBeNull());
    expect(bulle().classList.contains('tour-bubble-centre')).toBe(false);
    cible.remove();
  });

  it('donne le focus à la bulle pour que la visite se suive au clavier', async () => {
    afficher();

    await waitFor(() => expect(document.activeElement).toBe(bulle()));
  });

  it('retient la tabulation dans la bulle, que le voile ne retient pas', async () => {
    const utilisateur = userEvent.setup();
    afficher();
    await waitFor(() => expect(document.activeElement).toBe(bulle()));
    // Un bouton de la coque, resté sous le voile et après la bulle dans l'ordre du document :
    // la souris ne l'atteint plus, la tabulation l'atteindrait sans rien pour l'en empêcher.
    const dehors = document.createElement('button');
    document.body.append(dehors);
    const boutons = [...bulle().querySelectorAll('button')];

    boutons[boutons.length - 1].focus();
    await utilisateur.tab();
    expect(document.activeElement).toBe(boutons[0]);

    await utilisateur.tab({ shift: true });
    expect(document.activeElement).toBe(boutons[boutons.length - 1]);
    expect(document.activeElement).not.toBe(dehors);
    dehors.remove();
  });

  it('rend le focus à ce qui l’avait avant elle', async () => {
    const déclencheur = document.createElement('button');
    document.body.append(déclencheur);
    déclencheur.focus();

    const { rendu } = afficher();
    await waitFor(() => expect(document.activeElement).toBe(bulle()));
    rendu.unmount();

    expect(document.activeElement).toBe(déclencheur);
    déclencheur.remove();
  });
});

describe('mémoire de la visite', () => {
  it('ne se souvient de rien avant le premier lancement', () => {
    expect(visiteDéjàFaite()).toBe(false);
  });

  it('retient la visite une fois lancée', () => {
    marquerVisiteFaite();

    expect(visiteDéjàFaite()).toBe(true);
  });

  it('se note faite en s’ouvrant, sans attendre la dernière étape', () => {
    afficher();

    expect(visiteDéjàFaite()).toBe(true);
  });

  it('survit à un stockage indisponible plutôt que de casser l’application', () => {
    const refus = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('mode privé');
    });

    expect(() => marquerVisiteFaite()).not.toThrow();

    refus.mockRestore();
  });
});
