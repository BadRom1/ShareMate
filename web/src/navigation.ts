import { useCallback, useEffect, useRef, useState } from 'react';
import { getLastEquipmentId } from './lastEquipment';

/**
 * Navigation « équipement = espace de travail » : on choisit un équipement, puis tout se joue
 * dans ses onglets. La route est écrite dans l'URL pour que le bouton Retour du navigateur
 * revienne à l'écran précédent, et pour qu'un lien de notification ouvre le bon écran.
 */
export type Tab = 'agenda' | 'maintenance' | 'expenses' | 'forum' | 'documents';

/** Ordre d'affichage dans la barre basse. */
export const TABS: { id: Tab; label: string }[] = [
  { id: 'agenda', label: 'Agenda' },
  { id: 'maintenance', label: 'Entretien' },
  { id: 'expenses', label: 'Dépenses' },
  { id: 'forum', label: 'Forum' },
  { id: 'documents', label: 'Documents' },
];

/** Sous-section de l'onglet Entretien. */
export type MaintenanceSection = 'usage' | 'checklists';

export type Route =
  | { view: 'equipment'; equipmentId: string | null; tab: Tab; section: MaintenanceSection; threadId: string | null }
  | { view: 'overview' }
  /** Gestion du parc : créer, modifier, quitter ou supprimer un équipement. */
  | { view: 'equipments' };

/** Route d'équipement seule, pour les fonctions qui n'ont pas à traiter la vue d'ensemble. */
type EquipmentRoute = Extract<Route, { view: 'equipment' }>;

/** Changement partiel appliqué à la route courante : les champs absents sont conservés. */
export type RouteChange = { view?: Route['view'] } & Partial<Omit<EquipmentRoute, 'view'>>;

/**
 * Traduction du vocabulaire d'onglets. Les liens déjà envoyés par le serveur portent les anciens
 * noms (`discussions`, `calendar`, `usage`, `checklists`, `equipments`) : ils doivent continuer
 * d'ouvrir le bon écran, y compris depuis une notification reçue avant la mise à jour.
 */
const TAB_ALIASES: Record<string, { tab: Tab; section?: MaintenanceSection }> = {
  agenda: { tab: 'agenda' },
  calendar: { tab: 'agenda' },
  maintenance: { tab: 'maintenance' },
  usage: { tab: 'maintenance', section: 'usage' },
  checklists: { tab: 'maintenance', section: 'checklists' },
  expenses: { tab: 'expenses' },
  forum: { tab: 'forum' },
  discussions: { tab: 'forum' },
  documents: { tab: 'documents' },
};

/** Anciens et nouveaux noms de l'écran transverse, qui n'est pas un onglet d'équipement. */
const OVERVIEW_TABS = ['equipments', 'overview'];

const DEFAULT_SECTION: MaintenanceSection = 'usage';

function isSection(value: string | null): value is MaintenanceSection {
  return value === 'usage' || value === 'checklists';
}

/** Route par défaut : le premier onglet du dernier équipement consulté. */
function defaultRoute(): EquipmentRoute {
  return {
    view: 'equipment',
    equipmentId: getLastEquipmentId(),
    tab: TABS[0].id,
    section: DEFAULT_SECTION,
    threadId: null,
  };
}

/** Lit une URL (absolue ou relative) et en tire une route, ou `null` si elle ne décrit pas de route. */
export function parseRoute(url: string): Route | null {
  let params: URLSearchParams;
  try {
    params = new URL(url, window.location.origin).searchParams;
  } catch {
    return null;
  }
  const tab = params.get('tab');
  const view = params.get('view');
  // `?tab=equipments` reste la vue d'ensemble : la notification annonce ce qui a changé dans le
  // parc, pas un formulaire à remplir. Seule la coque ouvre l'écran de gestion.
  if (view === 'overview' || (tab && OVERVIEW_TABS.includes(tab))) return { view: 'overview' };
  if (view === 'equipments') return { view: 'equipments' };
  if (!tab) return null;
  const alias = TAB_ALIASES[tab];
  // Onglet inconnu : mieux vaut ignorer le lien que vider l'écran du membre.
  if (!alias) return null;
  const section = params.get('section');
  return {
    view: 'equipment',
    equipmentId: params.get('equipment'),
    tab: alias.tab,
    // Le nom d'onglet hérité désigne déjà sa sous-section ; sinon c'est le paramètre qui tranche.
    section: alias.section ?? (isSection(section) ? section : DEFAULT_SECTION),
    threadId: params.get('thread'),
  };
}

/**
 * Sérialise une route en query string (`?equipment=e1&tab=agenda`), sans clé superflue : la
 * sous-section et le fil ne sont écrits que dans l'onglet où ils ont un sens.
 */
export function routeToSearch(route: Route): string {
  // Les écrans transverses n'appartiennent à aucun équipement : leur nom suffit à les décrire.
  if (route.view !== 'equipment') return `?view=${route.view}`;
  const params = new URLSearchParams();
  if (route.equipmentId) params.set('equipment', route.equipmentId);
  params.set('tab', route.tab);
  if (route.tab === 'maintenance' && route.section !== DEFAULT_SECTION) params.set('section', route.section);
  if (route.tab === 'forum' && route.threadId) params.set('thread', route.threadId);
  return `?${params.toString()}`;
}

/** Applique un changement partiel à la route courante. */
function applyChange(current: Route, change: RouteChange, fallback: EquipmentRoute): Route {
  const view = change.view ?? current.view;
  // On ne quitte un écran transverse qu'en le disant : sans `view`, un changement d'onglet
  // préparerait l'écran d'équipement sous-jacent sans l'afficher.
  if (view !== 'equipment') return { view };
  // Depuis la vue d'ensemble, on retrouve l'équipement quitté plutôt que de repartir de zéro.
  const base = current.view === 'equipment' ? current : fallback;
  const equipmentId = change.equipmentId !== undefined ? change.equipmentId : base.equipmentId;
  const tab = change.tab ?? base.tab;
  return {
    view: 'equipment',
    equipmentId,
    tab,
    section: change.section ?? base.section,
    // Un fil n'existe que dans le forum de son équipement : en changer le referme,
    // à moins que l'appelant n'en désigne un explicitement.
    threadId:
      change.threadId !== undefined
        ? change.threadId
        : tab === 'forum' && equipmentId === base.equipmentId
          ? base.threadId
          : null,
  };
}

/** État de navigation synchronisé avec l'historique du navigateur. */
export function useRoute(initial?: Route): {
  route: Route;
  /** Remplace la route et empile une entrée d'historique. */
  go: (next: RouteChange) => void;
  /** Applique un lien de notification (`/?tab=discussions&equipment=e1&thread=t1`). */
  follow: (link: string) => void;
} {
  // Un lien de notification ouvert directement l'emporte sur la route proposée par l'appelant.
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.href) ?? initial ?? defaultRoute());
  const first = useRef(true);
  const lastEquipmentRoute = useRef<EquipmentRoute>(route.view === 'equipment' ? route : defaultRoute());

  useEffect(() => {
    if (route.view === 'equipment') lastEquipmentRoute.current = route;
    const search = routeToSearch(route);
    const isFirst = first.current;
    first.current = false;
    // Retour navigateur : l'URL porte déjà cette route, la réécrire empilerait une entrée fantôme.
    if (window.location.search === search) return;
    // Au premier rendu, l'entrée courante est simplement complétée : le Retour doit sortir de
    // l'application, pas ramener à l'URL par laquelle on est entré.
    if (isFirst) window.history.replaceState(null, '', search);
    else window.history.pushState(null, '', search);
  }, [route]);

  useEffect(() => {
    const onPopState = () => {
      const next = parseRoute(window.location.href);
      if (next) setRoute(next);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const go = useCallback((next: RouteChange) => {
    setRoute((current) => applyChange(current, next, lastEquipmentRoute.current));
  }, []);

  const follow = useCallback((link: string) => {
    const next = parseRoute(link);
    if (next) setRoute(next);
  }, []);

  return { route, go, follow };
}
