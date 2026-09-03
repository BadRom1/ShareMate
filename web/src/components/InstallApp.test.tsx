import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InstallAppCard } from './InstallApp';

/**
 * L'encart d'installation ne dépend que du navigateur : aucun appel d'API, mais un contexte
 * d'exécution à contrefaire — événement `beforeinstallprompt`, plateforme, mode d'affichage.
 */

const NAVIGATEUR_INITIAL = {
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  maxTouchPoints: navigator.maxTouchPoints,
};

function simulerNavigateur(valeurs: Partial<typeof NAVIGATEUR_INITIAL>) {
  for (const [clé, valeur] of Object.entries(valeurs)) {
    Object.defineProperty(navigator, clé, { value: valeur, configurable: true });
  }
}

/** Rejoue l'événement que Chrome tire quand l'application remplit les critères d'installation. */
function annoncerLInstallation(prompt = vi.fn().mockResolvedValue(undefined)) {
  const événement = Object.assign(new Event('beforeinstallprompt'), { prompt });
  window.dispatchEvent(événement);
  return prompt;
}

afterEach(() => {
  // Le prompt est retenu au niveau du module : sans cet oubli explicite, il déborderait d'un test
  // à l'autre. `appinstalled` est justement le signal par lequel le navigateur le périme.
  window.dispatchEvent(new Event('appinstalled'));
  simulerNavigateur(NAVIGATEUR_INITIAL);
  delete (window as { Capacitor?: unknown }).Capacitor;
  vi.unstubAllGlobals();
});

describe("encart d'installation", () => {
  it("n'affiche rien tant que le navigateur ne propose pas l'installation", () => {
    const { container } = render(<InstallAppCard />);

    // Ni prompt retenu, ni iOS : un encart qui ne mènerait nulle part vaut moins que pas d'encart.
    expect(container.innerHTML).toBe('');
  });

  it("propose le bouton dès que le navigateur annonce l'installation, et déclenche le prompt natif", async () => {
    const utilisateur = userEvent.setup();
    render(<InstallAppCard />);
    const prompt = annoncerLInstallation();

    const bouton = await screen.findByRole('button', { name: "Installer l'app" });
    await utilisateur.click(bouton);

    expect(prompt).toHaveBeenCalled();
  });

  it("retient l'annonce faite avant le premier rendu", async () => {
    // Chrome ne tire l'événement qu'une fois, souvent avant que React n'ait monté quoi que ce soit.
    annoncerLInstallation();

    render(<InstallAppCard />);

    expect(await screen.findByRole('button', { name: "Installer l'app" })).toBeTruthy();
  });

  it("retire l'encart une fois l'application installée", async () => {
    render(<InstallAppCard />);
    annoncerLInstallation();
    await screen.findByRole('button', { name: "Installer l'app" });

    window.dispatchEvent(new Event('appinstalled'));

    await waitFor(() => expect(screen.queryByRole('button', { name: "Installer l'app" })).toBeNull());
  });

  it("n'affiche rien dans l'application Android, où le même bundle tourne sous Capacitor", () => {
    (window as { Capacitor?: unknown }).Capacitor = {};
    annoncerLInstallation();

    const { container } = render(<InstallAppCard />);

    expect(container.innerHTML).toBe('');
  });

  it("n'affiche rien quand l'application tourne déjà sur l'écran d'accueil", () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((requête: string) => ({ matches: requête === '(display-mode: standalone)' })),
    );
    annoncerLInstallation();

    const { container } = render(<InstallAppCard />);

    expect(container.innerHTML).toBe('');
  });

  it("dicte les étapes manuelles sur iPhone, faute d'API d'installation", () => {
    simulerNavigateur({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Safari/605.1.15' });

    render(<InstallAppCard />);

    expect(screen.getByText(/Partager/)).toBeTruthy();
    expect(screen.getByText(/Sur l’écran d’accueil/)).toBeTruthy();
    // Aucune API à déclencher ici : promettre un bouton serait mentir.
    expect(screen.queryByRole('button', { name: "Installer l'app" })).toBeNull();
  });

  it('reconnaît un iPad, qui se déclare pourtant comme un Mac', () => {
    simulerNavigateur({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.4 Safari/605.1.15',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    });

    render(<InstallAppCard />);

    expect(screen.getByText(/Sur l’écran d’accueil/)).toBeTruthy();
  });

  it('laisse un Mac de bureau tranquille', () => {
    simulerNavigateur({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.4 Safari/605.1.15',
      platform: 'MacIntel',
      maxTouchPoints: 0,
    });

    const { container } = render(<InstallAppCard />);

    expect(container.innerHTML).toBe('');
  });
});
