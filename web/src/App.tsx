import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, setUnauthorizedHandler } from './api';
import type { DirectoryMember, Member } from './api';
import { EquipmentsPage } from './pages/EquipmentsPage';
import { CalendarPage } from './pages/CalendarPage';
import { MaintenancePage } from './pages/MaintenancePage';
import { ExpensesPage } from './pages/ExpensesPage';
import { DiscussionsPage } from './pages/DiscussionsPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { AdminPage } from './pages/AdminPage';
import { BootstrapPage, InvitePage, LoginPage } from './pages/AuthPages';
import { AppShell } from './components/AppShell';
import { OverviewPanel } from './components/OverviewPanel';
import { IconClose } from './components/icons';
import { useRoute } from './navigation';
import { useEscape } from './useEscape';
import { pickInitialEquipmentId, setLastEquipmentId } from './lastEquipment';
import { clearErrors, firstError, useApiResource } from './useApiResource';

type Auth =
  | { kind: 'loading' }
  | { kind: 'invite'; code: string }
  | { kind: 'anonymous'; needsBootstrap: boolean }
  | { kind: 'authenticated'; member: Member };

/** Code d'invitation porté par l'URL, s'il y en a un : `/invite/<code>`. */
function codeInvitation(): string | null {
  const found = window.location.pathname.match(/^\/invite\/([^/]+)$/);
  return found ? decodeURIComponent(found[1]) : null;
}

export function App() {
  // Un lien d'invitation dit l'état de départ à lui seul : inutile de passer par « Chargement… »
  // puis d'attendre le serveur pour afficher un écran que l'URL désignait déjà.
  const [auth, setAuth] = useState<Auth>(() => {
    const code = codeInvitation();
    return code === null ? { kind: 'loading' } : { kind: 'invite', code };
  });

  const backToLogin = useCallback(async () => {
    try {
      const state = await api.me();
      setAuth({ kind: 'anonymous', needsBootstrap: state.needsBootstrap });
    } catch {
      setAuth({ kind: 'anonymous', needsBootstrap: false });
    }
  }, []);

  const enterApp = useCallback((member: Member) => {
    // Une invitation consommée ne doit pas rester dans l'URL.
    if (window.location.pathname !== '/') {
      window.history.replaceState(null, '', '/');
    }
    setAuth({ kind: 'authenticated', member });
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => void backToLogin());
    return () => setUnauthorizedHandler(null);
  }, [backToLogin]);

  useEffect(() => {
    // Une invitation se joue entre le lien et l'écran de bienvenue : l'état de départ est déjà fixé.
    if (codeInvitation() !== null) return;
    api
      .me()
      .then((state) =>
        setAuth(
          state.member
            ? { kind: 'authenticated', member: state.member }
            : { kind: 'anonymous', needsBootstrap: state.needsBootstrap },
        ),
      )
      .catch(() => setAuth({ kind: 'anonymous', needsBootstrap: false }));
  }, []);

  if (auth.kind === 'loading') {
    return <p className="empty">Chargement…</p>;
  }
  if (auth.kind === 'invite') {
    return <InvitePage code={auth.code} onRedeemed={enterApp} />;
  }
  if (auth.kind === 'anonymous') {
    return auth.needsBootstrap ? <BootstrapPage onCreated={enterApp} /> : <LoginPage onLoggedIn={enterApp} />;
  }
  return <AuthenticatedApp member={auth.member} onLoggedOut={() => void backToLogin()} />;
}

/**
 * Gestion du parc : écran plein cadre posé par-dessus la coque, jumeau de la vue d'ensemble.
 * Même patron visuel, donc mêmes sorties — le bouton Fermer et la touche Échap.
 */
function EquipmentsScreen({
  members,
  currentMemberId,
  onMemberCreated,
  onClose,
}: {
  members: DirectoryMember[];
  currentMemberId: string;
  onMemberCreated: (member: DirectoryMember) => void;
  onClose: () => void;
}) {
  useEscape(onClose);

  return (
    <section className="screen" aria-label="Mes équipements">
      <div className="screen-inner">
        <header className="screen-head">
          <h2>Mes équipements</h2>
          <button type="button" className="icon-btn" onClick={onClose} title="Fermer" aria-label="Fermer">
            <IconClose size={22} />
          </button>
        </header>
        <EquipmentsPage members={members} currentMemberId={currentMemberId} onMemberCreated={onMemberCreated} />
      </div>
    </section>
  );
}

/**
 * Administration de l'instance : même patron plein cadre que la gestion du parc, donc mêmes
 * sorties — le bouton Fermer et la touche Échap. Un seul compte y accède, et le serveur le
 * redit à chaque appel : l'écran n'est pas la garde, il en est la porte.
 */
function AdminScreen({ currentMemberId, onClose }: { currentMemberId: string; onClose: () => void }) {
  useEscape(onClose);

  return (
    <section className="screen" aria-label="Administration">
      <div className="screen-inner">
        <header className="screen-head">
          <h2>Administration</h2>
          <button type="button" className="icon-btn" onClick={onClose} title="Fermer" aria-label="Fermer">
            <IconClose size={22} />
          </button>
        </header>
        <AdminPage currentMemberId={currentMemberId} />
      </div>
    </section>
  );
}

/**
 * Application connectée : un équipement est l'espace de travail courant, ses cinq sections sont
 * les onglets de la coque, et deux écrans transverses (vue d'ensemble, gestion du parc) se posent
 * par-dessus. Tout cela se lit dans l'URL, donc dans l'historique du navigateur.
 */
function AuthenticatedApp({ member, onLoggedOut }: { member: Member; onLoggedOut: () => void }) {
  const { route, go, follow } = useRoute();
  const membersResource = useApiResource(useCallback(() => api.listMembers(), []));
  const equipmentsResource = useApiResource(useCallback(() => api.listEquipments(), []));

  /**
   * Membres créés depuis cette session, tenus à part le temps que l'annuaire les rende. La
   * relecture peut être lente, voire servie par le cache du service worker (réseau d'abord,
   * cache de secours) : sans ce complément, une personne qu'on vient de créer et d'inscrire au
   * cercle s'y afficherait sous son identifiant brut. Le doublon se résorbe tout seul dès que
   * l'annuaire la porte.
   */
  const [membresCréés, setMembresCréés] = useState<DirectoryMember[]>([]);
  const chargés = membersResource.data;
  const members = useMemo(() => {
    if (chargés === null) return null;
    const connus = new Set(chargés.map((m) => m.id));
    return [...chargés, ...membresCréés.filter((m) => !connus.has(m.id))];
  }, [chargés, membresCréés]);
  const equipments = equipmentsResource.data;

  const reloadMembers = membersResource.reload;
  const onMemberCreated = useCallback(
    (member: DirectoryMember) => {
      setMembresCréés((liste) => [...liste, member]);
      void reloadMembers();
    },
    [reloadMembers],
  );

  /**
   * Équipement de l'espace de travail courant. Le lien n'en désigne pas toujours un
   * (`/?tab=calendar`) et peut en désigner un qui ne nous est plus partagé : dans les deux cas on
   * retombe sur le dernier consulté plutôt que sur un écran vide.
   */
  const currentEquipmentId =
    equipments === null || equipments.length === 0
      ? null
      : pickInitialEquipmentId(equipments, member.id, {
          deepLink: route.view === 'equipment' ? route.equipmentId : null,
        }) || null;

  // La prochaine ouverture reprend là où on en était, même sans équipement dans l'URL.
  useEffect(() => {
    if (currentEquipmentId) setLastEquipmentId(currentEquipmentId);
  }, [currentEquipmentId]);

  // L'écran de gestion crée et supprime des équipements : la coque relit la liste en le quittant,
  // par le bouton Fermer comme par le retour navigateur — mais pas en se démontant, sinon la
  // déconnexion partirait chercher un parc qu'on n'a plus le droit de lire.
  const reloadEquipments = equipmentsResource.reload;
  const gestionOuverte = useRef(false);
  useEffect(() => {
    if (route.view === 'equipments') gestionOuverte.current = true;
    else if (gestionOuverte.current) {
      gestionOuverte.current = false;
      void reloadEquipments();
    }
  }, [route.view, reloadEquipments]);

  // Clics de notification Web Push relayés par le service worker.
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'notification-click' && typeof e.data.link === 'string') follow(e.data.link);
    };
    sw.addEventListener('message', onMessage);
    return () => sw.removeEventListener('message', onMessage);
  }, [follow]);

  async function logout() {
    try {
      await api.logout();
    } finally {
      onLoggedOut();
    }
  }

  const error = firstError(membersResource, equipmentsResource);

  // Annuaire et parc sont les deux dépendances de tous les écrans : rien ne s'affiche avant eux.
  if (members === null || equipments === null) {
    return error ? <div className="alert">{error}</div> : <p className="empty">Chargement…</p>;
  }

  if (route.view === 'overview') {
    return (
      <OverviewPanel
        equipments={equipments}
        members={members}
        currentMemberId={member.id}
        onOpenEquipment={(equipmentId, tab) => go({ view: 'equipment', equipmentId, tab })}
        onClose={() => go({ view: 'equipment' })}
      />
    );
  }

  if (route.view === 'admin') {
    return <AdminScreen currentMemberId={member.id} onClose={() => go({ view: 'equipment' })} />;
  }

  if (route.view === 'equipments') {
    return (
      <EquipmentsScreen
        members={members}
        currentMemberId={member.id}
        onMemberCreated={onMemberCreated}
        onClose={() => go({ view: 'equipment' })}
      />
    );
  }

  const currentEquipment = equipments.find((e) => e.id === currentEquipmentId) ?? null;

  return (
    <AppShell
      equipments={equipments}
      currentEquipmentId={currentEquipmentId}
      tab={route.tab}
      member={member}
      onSelectEquipment={(equipmentId) => go({ view: 'equipment', equipmentId })}
      onSelectTab={(tab) => go({ tab })}
      onOpenOverview={() => go({ view: 'overview' })}
      onAddEquipment={() => go({ view: 'equipments' })}
      onOpenAdmin={() => go({ view: 'admin' })}
      onNavigate={follow}
      onLogout={() => void logout()}
    >
      {error && (
        <div className="alert" onClick={() => clearErrors(membersResource, equipmentsResource)}>
          {error}
        </div>
      )}

      {currentEquipment === null ? (
        <>
          <p className="empty">Aucun équipement partagé avec vous. Ajoutez votre minipelle, utilitaire, bétonnière…</p>
          <button className="primary" onClick={() => go({ view: 'equipments' })}>
            + Ajouter un équipement
          </button>
        </>
      ) : (
        <>
          {/*
           * `key` sur l'équipement : changer d'espace de travail remet chaque onglet à neuf —
           * fil ouvert, filtres, brouillons de saisie. Le dire ici une fois vaut mieux que le
           * réparer page par page dans un effet, qui laissait un rendu avec l'état du précédent.
           */}
          {route.tab === 'agenda' && (
            <CalendarPage
              key={currentEquipment.id}
              members={members}
              currentMemberId={member.id}
              equipment={currentEquipment}
              // Le relevé se saisit dans l'entretien de l'équipement du créneau, pas de celui affiché.
              onRecordUsage={(equipmentId) =>
                go({ view: 'equipment', equipmentId, tab: 'maintenance', section: 'usage' })
              }
            />
          )}
          {route.tab === 'maintenance' && (
            <MaintenancePage
              key={currentEquipment.id}
              members={members}
              currentMemberId={member.id}
              equipment={currentEquipment}
              section={route.section}
              onSelectSection={(section) => go({ section })}
            />
          )}
          {route.tab === 'expenses' && (
            <ExpensesPage
              key={currentEquipment.id}
              members={members}
              currentMemberId={member.id}
              equipment={currentEquipment}
            />
          )}
          {route.tab === 'forum' && (
            <DiscussionsPage
              key={currentEquipment.id}
              members={members}
              currentMemberId={member.id}
              equipment={currentEquipment}
              initialThreadId={route.threadId}
            />
          )}
          {route.tab === 'documents' && (
            <DocumentsPage
              key={currentEquipment.id}
              members={members}
              currentMemberId={member.id}
              equipment={currentEquipment}
            />
          )}
        </>
      )}
    </AppShell>
  );
}
