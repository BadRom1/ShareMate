import { useEffect } from 'react';

/**
 * Ferme à la touche Échap l'écran plein cadre qui appelle ce hook.
 *
 * Les deux écrans transverses (vue d'ensemble, gestion du parc) sont des jumeaux : même patron
 * visuel, même bouton Fermer. Sans ce hook partagé, ils finissaient par diverger au clavier.
 *
 * Une boîte de dialogue ouverte par-dessus garde la main : c'est elle qu'Échap referme, pas
 * l'écran qui la porte — sinon un seul appui emporterait les deux.
 */
export function useEscape(onEscape: () => void): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (document.querySelector('[aria-modal="true"]')) return;
      onEscape();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onEscape]);
}
