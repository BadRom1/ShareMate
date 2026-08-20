import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Route } from './navigation';
import { TABS, parseRoute, routeToSearch, useRoute } from './navigation';

/** Route d'équipement complète, dont le test ne précise que ce qui l'intéresse. */
function aRoute(over: Partial<Extract<Route, { view: 'equipment' }>> = {}): Route {
  return { view: 'equipment', equipmentId: 'e1', tab: 'agenda', section: 'usage', threadId: null, ...over };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
});

describe('parseRoute', () => {
  it('accepte les noms d’onglets actuels', () => {
    expect(parseRoute('/?tab=agenda&equipment=e1')).toEqual(aRoute());
    expect(parseRoute('/?tab=expenses&equipment=e1')).toEqual(aRoute({ tab: 'expenses' }));
    expect(parseRoute('/?tab=documents&equipment=e1')).toEqual(aRoute({ tab: 'documents' }));
    expect(parseRoute('/?tab=forum&equipment=e1')).toEqual(aRoute({ tab: 'forum' }));
    expect(parseRoute('/?tab=maintenance&equipment=e1')).toEqual(aRoute({ tab: 'maintenance' }));
  });

  it('traduit l’ancien onglet Discussions vers le forum', () => {
    expect(parseRoute('/?tab=discussions&equipment=e1')).toEqual(aRoute({ tab: 'forum' }));
  });

  it('traduit l’ancien onglet Calendrier vers l’agenda', () => {
    expect(parseRoute('/?tab=calendar')).toEqual(aRoute({ equipmentId: null, tab: 'agenda' }));
  });

  it('traduit l’ancien onglet Usage vers la section Usage de l’entretien', () => {
    expect(parseRoute('/?tab=usage&equipment=e2')).toEqual(
      aRoute({ equipmentId: 'e2', tab: 'maintenance', section: 'usage' }),
    );
  });

  it('traduit l’ancien onglet Checklists vers la section Checklists de l’entretien', () => {
    expect(parseRoute('/?tab=checklists&equipment=e2')).toEqual(
      aRoute({ equipmentId: 'e2', tab: 'maintenance', section: 'checklists' }),
    );
  });

  it('traduit l’ancien onglet Documents et l’ancien onglet Dépenses à l’identique', () => {
    expect(parseRoute('/?tab=documents&equipment=e2')).toEqual(aRoute({ equipmentId: 'e2', tab: 'documents' }));
    expect(parseRoute('/?tab=expenses&equipment=e2')).toEqual(aRoute({ equipmentId: 'e2', tab: 'expenses' }));
  });

  it('traduit l’ancien onglet Équipements vers la vue d’ensemble', () => {
    expect(parseRoute('/?tab=equipments')).toEqual({ view: 'overview' });
    expect(parseRoute('/?view=overview')).toEqual({ view: 'overview' });
  });

  // L'écran de gestion du parc n'a pas d'ancien nom d'onglet : `?tab=equipments` reste la vue
  // d'ensemble, seule la coque ouvre la gestion.
  it('ouvre l’écran de gestion du parc sur ?view=equipments', () => {
    expect(parseRoute('/?view=equipments')).toEqual({ view: 'equipments' });
  });

  it('retient le fil désigné par un lien de notification', () => {
    expect(parseRoute('/?tab=discussions&equipment=e1&thread=t1')).toEqual(aRoute({ tab: 'forum', threadId: 't1' }));
  });

  it('lit la sous-section d’entretien passée à part', () => {
    expect(parseRoute('/?tab=maintenance&equipment=e1&section=checklists')).toEqual(
      aRoute({ tab: 'maintenance', section: 'checklists' }),
    );
  });

  it('ignore un lien dont l’onglet est inconnu', () => {
    expect(parseRoute('/?tab=inconnu&equipment=e1')).toBeNull();
  });

  it('ignore une URL qui ne désigne aucun onglet', () => {
    expect(parseRoute('/')).toBeNull();
    expect(parseRoute('/?equipment=e1')).toBeNull();
    expect(parseRoute('http://:')).toBeNull();
  });

  it('accepte une URL absolue comme une URL relative', () => {
    expect(parseRoute('https://sharemate.example/?tab=forum&equipment=e1')).toEqual(aRoute({ tab: 'forum' }));
  });
});

describe('routeToSearch', () => {
  it('n’écrit pas de clé superflue', () => {
    expect(routeToSearch(aRoute())).toBe('?equipment=e1&tab=agenda');
    expect(routeToSearch(aRoute({ equipmentId: null }))).toBe('?tab=agenda');
    // Le fil et la sous-section n'ont de sens que dans leur onglet.
    expect(routeToSearch(aRoute({ tab: 'agenda', threadId: 't1', section: 'checklists' }))).toBe(
      '?equipment=e1&tab=agenda',
    );
    expect(routeToSearch({ view: 'overview' })).toBe('?view=overview');
    expect(routeToSearch({ view: 'equipments' })).toBe('?view=equipments');
  });

  it('écrit le fil du forum et la sous-section d’entretien', () => {
    expect(routeToSearch(aRoute({ tab: 'forum', threadId: 't1' }))).toBe('?equipment=e1&tab=forum&thread=t1');
    expect(routeToSearch(aRoute({ tab: 'maintenance', section: 'checklists' }))).toBe(
      '?equipment=e1&tab=maintenance&section=checklists',
    );
  });

  it('se relit à l’identique', () => {
    const routes: Route[] = [
      aRoute(),
      aRoute({ equipmentId: null, tab: 'expenses' }),
      aRoute({ tab: 'forum', threadId: 't1' }),
      aRoute({ tab: 'maintenance', section: 'checklists' }),
      aRoute({ tab: 'maintenance', section: 'usage' }),
      aRoute({ tab: 'documents' }),
      { view: 'overview' },
      { view: 'equipments' },
    ];
    for (const route of routes) expect(parseRoute(routeToSearch(route))).toEqual(route);
  });
});

describe('TABS', () => {
  it('liste les cinq onglets de la barre basse dans l’ordre', () => {
    expect(TABS.map((t) => t.id)).toEqual(['agenda', 'maintenance', 'expenses', 'forum', 'documents']);
    expect(TABS.map((t) => t.label)).toEqual(['Agenda', 'Entretien', 'Dépenses', 'Forum', 'Documents']);
  });
});

describe('useRoute', () => {
  it('part de la route proposée quand l’URL n’en désigne aucune', () => {
    const { result } = renderHook(() => useRoute(aRoute({ equipmentId: 'e3', tab: 'forum' })));

    expect(result.current.route).toEqual(aRoute({ equipmentId: 'e3', tab: 'forum' }));
  });

  it('ouvre la route du lien par lequel l’application a été lancée', () => {
    window.history.replaceState(null, '', '/?tab=usage&equipment=e2');

    const { result } = renderHook(() => useRoute());

    expect(result.current.route).toEqual(aRoute({ equipmentId: 'e2', tab: 'maintenance', section: 'usage' }));
  });

  it('n’empile pas d’entrée d’historique au premier rendu', () => {
    const push = vi.spyOn(window.history, 'pushState');
    window.history.replaceState(null, '', '/?tab=discussions&equipment=e2');

    renderHook(() => useRoute());

    expect(push).not.toHaveBeenCalled();
    // L'URL est normalisée sur place, dans le vocabulaire actuel.
    expect(window.location.search).toBe('?equipment=e2&tab=forum');
    push.mockRestore();
  });

  it('écrit l’URL et empile une entrée à chaque changement de route', () => {
    const { result } = renderHook(() => useRoute(aRoute()));
    const push = vi.spyOn(window.history, 'pushState');

    act(() => result.current.go({ tab: 'forum' }));

    expect(push).toHaveBeenCalledOnce();
    expect(window.location.search).toBe('?equipment=e1&tab=forum');
    expect(result.current.route).toEqual(aRoute({ tab: 'forum' }));
    push.mockRestore();
  });

  it('revient à l’onglet précédent au retour navigateur', async () => {
    const { result } = renderHook(() => useRoute(aRoute()));
    act(() => result.current.go({ tab: 'expenses' }));
    act(() => result.current.go({ tab: 'documents' }));

    act(() => window.history.back());

    await waitFor(() => expect(result.current.route).toEqual(aRoute({ tab: 'expenses' })));
    expect(window.location.search).toBe('?equipment=e1&tab=expenses');
  });

  it('n’empile pas d’entrée en revenant en arrière', async () => {
    const { result } = renderHook(() => useRoute(aRoute()));
    act(() => result.current.go({ tab: 'forum' }));
    const push = vi.spyOn(window.history, 'pushState');

    act(() => window.history.back());

    await waitFor(() => expect(result.current.route).toEqual(aRoute()));
    expect(push).not.toHaveBeenCalled();
    push.mockRestore();
  });

  it('suit un lien de notification reçu pendant la consultation', () => {
    const { result } = renderHook(() => useRoute(aRoute()));

    act(() => result.current.follow('/?tab=discussions&equipment=e2&thread=t1'));

    expect(result.current.route).toEqual(aRoute({ equipmentId: 'e2', tab: 'forum', threadId: 't1' }));
    expect(window.location.search).toBe('?equipment=e2&tab=forum&thread=t1');
  });

  it('ignore un lien de notification dont l’onglet est inconnu', () => {
    const { result } = renderHook(() => useRoute(aRoute()));

    act(() => result.current.follow('/?tab=inconnu&equipment=e2'));

    expect(result.current.route).toEqual(aRoute());
  });

  it('referme le fil ouvert quand on quitte le forum ou l’équipement', () => {
    const { result } = renderHook(() => useRoute(aRoute({ tab: 'forum', threadId: 't1' })));

    act(() => result.current.go({ tab: 'agenda' }));
    expect(result.current.route).toEqual(aRoute({ tab: 'agenda', threadId: null }));

    act(() => result.current.go({ tab: 'forum', threadId: 't1' }));
    act(() => result.current.go({ equipmentId: 'e2' }));
    expect(result.current.route).toEqual(aRoute({ equipmentId: 'e2', tab: 'forum', threadId: null }));
  });

  it('retrouve l’équipement quitté en revenant de la vue d’ensemble', () => {
    const { result } = renderHook(() => useRoute(aRoute({ equipmentId: 'e2', tab: 'documents' })));

    act(() => result.current.go({ view: 'overview' }));
    expect(result.current.route).toEqual({ view: 'overview' });
    expect(window.location.search).toBe('?view=overview');

    act(() => result.current.go({ view: 'equipment' }));
    expect(result.current.route).toEqual(aRoute({ equipmentId: 'e2', tab: 'documents' }));
  });

  it('retrouve l’équipement quitté en revenant de la gestion du parc', () => {
    const { result } = renderHook(() => useRoute(aRoute({ equipmentId: 'e2', tab: 'forum' })));

    act(() => result.current.go({ view: 'equipments' }));
    expect(result.current.route).toEqual({ view: 'equipments' });
    expect(window.location.search).toBe('?view=equipments');

    act(() => result.current.go({ view: 'equipment' }));
    expect(result.current.route).toEqual(aRoute({ equipmentId: 'e2', tab: 'forum' }));
  });

  it('reprend le dernier équipement consulté quand rien ne le désigne', () => {
    localStorage.setItem('sharemate.lastEquipmentId', 'e7');

    const { result } = renderHook(() => useRoute());

    expect(result.current.route).toEqual(aRoute({ equipmentId: 'e7', tab: 'agenda' }));
  });

  it('cesse d’écouter l’historique une fois démonté', async () => {
    const { result, unmount } = renderHook(() => useRoute(aRoute()));
    act(() => result.current.go({ tab: 'forum' }));
    const routeAuDemontage = result.current.route;

    unmount();
    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe('?equipment=e1&tab=agenda'));

    expect(result.current.route).toEqual(routeAuDemontage);
  });
});
