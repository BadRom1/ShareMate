import { useCallback } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ApiError } from './api';
import { clearErrors, errorMessage, firstError, useApiResource } from './useApiResource';

/** Mémoïse un chargement par clé, comme le fait une page avec `useCallback`. */
function useLoaderFor<K, T>(loader: (key: K) => Promise<T>, key: K): () => Promise<T> {
  return useCallback(() => loader(key), [loader, key]);
}

/** Promesse dont le test décide du moment de résolution. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useApiResource', () => {
  it('charge au montage et expose la donnée', async () => {
    const loader = vi.fn(async () => ['a']);
    const { result } = renderHook(() => useApiResource(loader));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual(['a']));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("retient le message d'erreur du serveur", async () => {
    const loader = vi.fn(async () => {
      throw new ApiError('Cercle introuvable.', 404);
    });
    const { result } = renderHook(() => useApiResource(loader));

    await waitFor(() => expect(result.current.error).toBe('Cercle introuvable.'));
    expect(result.current.loading).toBe(false);
  });

  it('recharge quand le loader change (nouvelle sélection)', async () => {
    const loader = vi.fn(async (id: string) => `données ${id}`);
    const { result, rerender } = renderHook(({ id }) => useApiResource(useLoaderFor(loader, id)), {
      initialProps: { id: 'e1' },
    });

    await waitFor(() => expect(result.current.data).toBe('données e1'));
    rerender({ id: 'e2' });
    await waitFor(() => expect(result.current.data).toBe('données e2'));
  });

  // Sélection changée deux fois de suite : la première réponse arrive en dernier et écraserait
  // l'affichage avec les données d'un équipement que le membre a déjà quitté.
  it("ignore la réponse d'un chargement dépassé", async () => {
    const lent = deferred<string>();
    const rapide = deferred<string>();
    let next = lent;
    const loader = vi.fn(() => next.promise);
    const { result, rerender } = renderHook(({ n }) => useApiResource(useLoaderFor(loader, n)), {
      initialProps: { n: 1 },
    });

    next = rapide;
    rerender({ n: 2 });
    await act(async () => {
      rapide.resolve('récent');
      lent.resolve('dépassé');
    });

    expect(result.current.data).toBe('récent');
  });

  it('efface le message sans relancer le chargement', async () => {
    const loader = vi.fn(async () => {
      throw new Error('Hors ligne.');
    });
    const { result } = renderHook(() => useApiResource(loader));
    await waitFor(() => expect(result.current.error).toBe('Hors ligne.'));

    act(() => result.current.clearError());

    expect(result.current.error).toBeNull();
    expect(loader).toHaveBeenCalledOnce();
  });

  // Attendre la fin du rechargement pour ne vérifier que la valeur finale n'attesterait de rien :
  // un `reload` qui remettrait `data` à null pendant le chargement — le clignotement que ce hook
  // supprime — passerait au vert. C'est l'état intermédiaire qui porte la propriété.
  it('conserve la donnée précédente pendant un rechargement', async () => {
    const premier = deferred<string>();
    const second = deferred<string>();
    let next = premier;
    const loader = vi.fn(() => next.promise);
    const { result } = renderHook(() => useApiResource(loader));
    await act(async () => premier.resolve('v1'));
    expect(result.current.data).toBe('v1');

    next = second;
    let rechargement!: Promise<void>;
    act(() => {
      rechargement = result.current.reload();
    });

    // Pendant le chargement : l'ancienne donnée reste affichée, l'indicateur tourne.
    expect(result.current.data).toBe('v1');
    expect(result.current.loading).toBe(true);

    await act(async () => {
      second.resolve('v2');
      await rechargement;
    });
    expect(result.current.data).toBe('v2');
    expect(result.current.loading).toBe(false);
  });
});

describe('bandeau de page', () => {
  it('retient la première erreur non résolue', () => {
    expect(firstError({ error: null }, { error: 'Cercle introuvable.' }, { error: 'Autre.' })).toBe(
      'Cercle introuvable.',
    );
    expect(firstError({ error: null }, { error: null })).toBeNull();
  });

  it('referme toutes les ressources', () => {
    const a = { clearError: vi.fn() };
    const b = { clearError: vi.fn() };
    clearErrors(a, b);
    expect(a.clearError).toHaveBeenCalledOnce();
    expect(b.clearError).toHaveBeenCalledOnce();
  });
});

describe('errorMessage', () => {
  it('rend le message des erreurs et un texte générique du reste', () => {
    expect(errorMessage(new Error('Précis.'))).toBe('Précis.');
    expect(errorMessage('chaîne jetée')).toBe('Erreur.');
  });
});
