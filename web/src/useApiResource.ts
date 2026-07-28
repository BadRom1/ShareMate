import { useCallback, useEffect, useRef, useState } from 'react';

/** Message affichable d'une exception : `ApiError` porte déjà celui du serveur. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Erreur.';
}

export interface ApiResource<T> {
  /** `null` tant que le premier chargement n'a pas abouti. */
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Relance le chargement (après une écriture, ou pour réessayer). */
  reload: () => Promise<void>;
  /** Efface le message affiché, sans relancer le chargement (bandeau refermé par le membre). */
  clearError: () => void;
}

/**
 * Charge une ressource d'API et suit son état, à la place du quatuor
 * `useState(data)/useState(error)/useCallback(load)/useEffect(load)` recopié dans chaque page.
 *
 * `loader` doit être mémoïsé (`useCallback`) : son identité déclenche le rechargement, comme une
 * dépendance d'effet. Les réponses hors séquence sont ignorées — un changement rapide de
 * sélection ferait sinon réapparaître les données de la sélection précédente.
 */
export function useApiResource<T>(loader: () => Promise<T>): ApiResource<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const lastRun = useRef(0);

  const reload = useCallback(async () => {
    const run = (lastRun.current += 1);
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await loader();
      if (run === lastRun.current) setState({ data, error: null, loading: false });
    } catch (e) {
      if (run === lastRun.current) setState((s) => ({ ...s, error: errorMessage(e), loading: false }));
    }
  }, [loader]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const clearError = useCallback(() => setState((s) => (s.error === null ? s : { ...s, error: null })), []);

  return { ...state, reload, clearError };
}

/** Une page n'affiche qu'un bandeau : la première erreur non résolue parmi ses ressources. */
export function firstError(...resources: { error: string | null }[]): string | null {
  return resources.find((r) => r.error !== null)?.error ?? null;
}

/** Referme le bandeau d'erreur d'une page alimentée par plusieurs ressources. */
export function clearErrors(...resources: { clearError: () => void }[]): void {
  for (const resource of resources) resource.clearError();
}
