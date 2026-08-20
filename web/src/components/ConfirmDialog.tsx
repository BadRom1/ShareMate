import { useRef, type ReactNode } from 'react';
import { Modal } from './Modal';

interface Props {
  title: string;
  /** Ce que le geste emporte, énuméré pour que l'utilisateur décide en connaissance de cause. */
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation d'un geste destructif. Contrairement à `confirm()`, elle laisse
 * détailler ce qui disparaît et ne pré-sélectionne jamais la confirmation :
 * le focus arrive sur « Annuler », et Échap comme le fond ferment sans rien casser.
 */
export function ConfirmDialog({ title, children, confirmLabel, busy = false, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Modal title={title} role="alertdialog" initialFocusRef={cancelRef} onClose={onCancel}>
      <div className="modal-body">{children}</div>
      <div className="modal-actions">
        <button type="button" className="ghost" ref={cancelRef} onClick={onCancel}>
          Annuler
        </button>
        <button type="button" className="danger" onClick={onConfirm} disabled={busy}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
