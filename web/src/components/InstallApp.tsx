import { useCallback, useSyncExternalStore } from 'react';

/**
 * Aide à l'installation de l'application sur l'écran d'accueil.
 *
 * Toute l'infrastructure PWA existe déjà (manifeste, icônes, service worker) : il ne manque que
 * le geste. Or ce geste n'est pas le même partout — Chrome le propose par une API, Safari le
 * cache dans son menu Partager, et ailleurs il n'existe pas. On ne montre donc l'encart que là
 * où il mène quelque part.
 */

/** Événement propriétaire de Chromium : le navigateur annonce qu'il sait installer l'application. */
interface ÉvénementInstallation extends Event {
  prompt: () => Promise<unknown>;
}

/**
 * Le navigateur ne tire `beforeinstallprompt` qu'une fois, souvent avant que React n'ait monté
 * quoi que ce soit. L'écoute est donc posée au chargement du module et non dans un effet : sinon
 * l'événement passe avant l'abonnement, et l'application ne se propose plus jamais.
 */
let promptRetenu: ÉvénementInstallation | null = null;
const abonnés = new Set<() => void>();

function prévenirLesAbonnés() {
  for (const abonné of abonnés) abonné();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (événement) => {
    // Sans ce refus, Chrome pose sa propre bannière : deux invitations pour un seul geste.
    événement.preventDefault();
    promptRetenu = événement as ÉvénementInstallation;
    prévenirLesAbonnés();
  });
  // L'application vient d'être installée : il n'y a plus rien à proposer, ici comme ailleurs.
  window.addEventListener('appinstalled', () => {
    promptRetenu = null;
    prévenirLesAbonnés();
  });
}

function souscrire(auChangement: () => void): () => void {
  abonnés.add(auChangement);
  return () => abonnés.delete(auChangement);
}

/**
 * L'application tourne-t-elle déjà hors du navigateur ? Trois façons de le dire, parce que trois
 * mondes : la PWA installée, l'astuce historique de Safari, et l'application Android — le même
 * bundle y tourne sous Capacitor, où proposer d'installer une PWA n'a aucun sens.
 */
function horsNavigateur(): boolean {
  if ('Capacitor' in window) return true;
  if ((navigator as { standalone?: boolean }).standalone === true) return true;
  // Absence de `matchMedia` (jsdom) : on ne sait pas, et ne pas savoir n'est pas savoir que oui.
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(display-mode: standalone)').matches;
}

/**
 * iOS et iPadOS, où aucune API n'existe et où l'installation se fait à la main.
 * Depuis iPadOS 13, un iPad se déclare comme un Mac : seul l'écran tactile le trahit.
 */
function surIOS(): boolean {
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
  return /Mac/.test(navigator.platform ?? '') && navigator.maxTouchPoints > 1;
}

/**
 * Ce que le navigateur permet : `prompt` pour l'invite native, `ios` pour les étapes à la main,
 * `null` quand il n'y a rien à proposer — déjà installée, ou navigateur qui ne sait pas faire.
 */
export type ModeInstallation = 'prompt' | 'ios' | null;

export function useInstallPrompt(): { mode: ModeInstallation; installer: () => Promise<void> } {
  const prompt = useSyncExternalStore(souscrire, () => promptRetenu);

  const installer = useCallback(async () => {
    const invite = promptRetenu;
    if (!invite) return;
    // Une invite ne se joue qu'une fois : la retirer d'abord évite un second clic sans effet.
    promptRetenu = null;
    prévenirLesAbonnés();
    await invite.prompt();
  }, []);

  const mode: ModeInstallation = horsNavigateur() ? null : prompt ? 'prompt' : surIOS() ? 'ios' : null;
  return { mode, installer };
}

/** Étapes manuelles de Safari : c'est l'utilisateur qui installe, l'application ne peut que dire comment. */
export function InstallSteps() {
  return (
    <ol className="install-steps">
      <li>Touchez le bouton Partager, dans la barre de Safari.</li>
      <li>Faites défiler puis choisissez « Sur l’écran d’accueil ».</li>
      <li>Validez : ShareMate s’ouvre ensuite comme une application.</li>
    </ol>
  );
}

/**
 * Encart d'installation, posé sur les écrans publics — c'est là qu'arrive celui qui suit un lien
 * d'invitation, et le meilleur moment pour lui éviter de chercher l'application plus tard.
 * Rien à proposer, rien à afficher : un encart qui ne mène nulle part vaut moins que pas d'encart.
 */
export function InstallAppCard() {
  const { mode, installer } = useInstallPrompt();
  if (mode === null) return null;

  return (
    <section className="install-panel" aria-label="Installer l’application">
      <strong>Installer ShareMate</strong>
      <p className="muted">
        Ajoutée à votre appareil, l’application s’ouvre en plein écran et se retrouve d’un geste, sans passer par le
        navigateur.
      </p>
      {mode === 'prompt' ? (
        <button type="button" className="primary" onClick={() => void installer()}>
          Installer l&apos;app
        </button>
      ) : (
        <InstallSteps />
      )}
    </section>
  );
}
