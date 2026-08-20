import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from './Modal';

function renderModal(onClose = vi.fn()) {
  const view = render(
    <Modal title="Saisie" onClose={onClose}>
      <form className="modal-form">
        <label className="field">
          Remarques
          <textarea />
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button className="primary">Enregistrer</button>
        </div>
      </form>
    </Modal>,
  );
  return { onClose, view };
}

function backdrop() {
  return document.querySelector('.modal-backdrop') as HTMLElement;
}

describe('Modal', () => {
  it('ferme sur Échap', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });

  it('ferme au clic sur le fond', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    await user.click(backdrop());

    expect(onClose).toHaveBeenCalled();
  });

  it('ne ferme pas quand le geste a commencé dans la boîte', () => {
    const { onClose } = renderModal();

    // Sélection de texte relâchée quelques pixels hors de la boîte : le `click` est
    // dispatché sur l'ancêtre commun, donc sur le fond. La saisie ne doit pas partir.
    fireEvent.mouseDown(screen.getByLabelText('Remarques'));
    fireEvent.click(backdrop());

    expect(onClose).not.toHaveBeenCalled();
  });

  it('boucle le focus sur les éléments de la boîte', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.tab({ shift: true });

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Enregistrer' }));
  });

  it('bloque le défilement du fond puis le rend', () => {
    const { view } = renderModal();
    expect(document.body.style.overflow).toBe('hidden');

    view.unmount();

    expect(document.body.style.overflow).toBe('');
  });

  it("rend le focus à ce qui l'a ouverte", () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();

    const { view } = renderModal();
    expect(document.activeElement).not.toBe(trigger);
    view.unmount();

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
