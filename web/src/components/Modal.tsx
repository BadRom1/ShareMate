import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { IconClose } from './icons';

/** Éléments atteignables au clavier : bornes du piège à focus. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Props {
  title: string;
  /** Le contenu de la boîte, boutons d'action compris (`.modal-form` + `.modal-actions`). */
  children: ReactNode;
  /** `alertdialog` pour une décision qui ne peut pas attendre (confirmation d'une suppression). */
  role?: 'dialog' | 'alertdialog';
  /**
   * `sheet` colle la boîte au bas de l'écran (feuille basse), à portée du pouce.
   * Même comportement clavier et même fermeture : seule la position change.
   */
  variant?: 'dialog' | 'sheet';
  /** Élément qui reçoit le focus à l'ouverture, à défaut de la boîte elle-même. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}

/**
 * Boîte de dialogue. Le formulaire vient à l'utilisateur au moment où il le demande,
 * au lieu d'occuper le haut de page — qui appartient à ce qu'il est venu consulter.
 * Échap et le fond ferment sans rien enregistrer.
 *
 * `aria-modal` promet que le reste de la page est hors d'atteinte : le focus tourne
 * en boucle dans la boîte, revient à son point de départ à la fermeture, et le fond
 * ne défile plus sous le doigt (la boîte occupe tout l'écran en dessous de 720 px).
 *
 * Le rendu passe par un portail vers `document.body` : une modale ouverte depuis un
 * ancêtre qui crée un contexte d'empilement (la barre d'app est `sticky` avec un
 * `z-index`) y serait plafonnée à *son* niveau et passerait sous la barre basse.
 * Depuis la racine, `z-index: 50` vaut de nouveau ce qu'il annonce.
 */
export function Modal({ title, children, role = 'dialog', variant = 'dialog', initialFocusRef, onClose }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  /** Le clic ne ferme que s'il a commencé sur le fond : une sélection de texte relâchée hors de la boîte n'efface pas la saisie. */
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const box = boxRef.current;
    // Un champ `autoFocus` a déjà pris la main : on ne la lui reprend pas.
    if (initialFocusRef?.current) initialFocusRef.current.focus();
    else if (box && !box.contains(document.activeElement)) box.focus();
    return () => previous?.focus?.();
  }, [initialFocusRef]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !boxRef.current) return;
      const focusable = [...boxRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === boxRef.current)) {
        last.focus();
        event.preventDefault();
      } else if (!event.shiftKey && active === last) {
        first.focus();
        event.preventDefault();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className={variant === 'sheet' ? 'modal-backdrop sheet' : 'modal-backdrop'}
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedBackdrop.current) onClose();
      }}
    >
      <div
        className="modal"
        role={role}
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={boxRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="icon-btn" onClick={onClose} title="Fermer" aria-label="Fermer">
            <IconClose size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
