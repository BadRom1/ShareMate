import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Fab } from './Fab';

describe('Fab', () => {
  it("nomme l'action au lieu de laisser l'icône parler seule", () => {
    render(<Fab label="Réserver un créneau" onClick={vi.fn()} />);

    const fab = screen.getByRole('button', { name: 'Réserver un créneau' });
    expect(fab.textContent).toBe('');
  });

  it('déclenche son action au clic', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Fab label="Saisir un relevé" onClick={onClick} />);

    await user.click(screen.getByRole('button', { name: 'Saisir un relevé' }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('se déclenche aussi au clavier', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Fab label="Ajouter une dépense" onClick={onClick} />);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ajouter une dépense' }));
    await user.keyboard('{Enter}');

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("ne soumet aucun formulaire de la page qui l'accueille", () => {
    const onSubmit = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <Fab label="Déposer un fichier" onClick={vi.fn()} />
      </form>,
    );

    expect(screen.getByRole('button', { name: 'Déposer un fichier' }).getAttribute('type')).toBe('button');
  });
});
