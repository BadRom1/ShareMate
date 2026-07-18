import { useCallback, useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api';
import type { Member } from './api';
import { EquipmentsPage } from './pages/EquipmentsPage';
import { CalendarPage } from './pages/CalendarPage';
import { UsagePage } from './pages/UsagePage';
import { ExpensesPage } from './pages/ExpensesPage';
import { DiscussionsPage } from './pages/DiscussionsPage';
import { BootstrapPage, InvitePage, LoginPage } from './pages/AuthPages';
import { NotificationBell } from './components/NotificationBell';
import { UserMenu } from './components/UserMenu';
import { setupNativePush } from './notifications';

type Tab = 'equipments' | 'calendar' | 'usage' | 'expenses' | 'discussions';

const TABS: { id: Tab; label: string }[] = [
  { id: 'equipments', label: 'Équipements' },
  { id: 'calendar', label: 'Calendrier' },
  { id: 'usage', label: 'Usage & entretien' },
  { id: 'expenses', label: 'Dépenses & soldes' },
  { id: 'discussions', label: 'Discussions' },
];

type Auth =
  | { kind: 'loading' }
  | { kind: 'invite'; code: string }
  | { kind: 'anonymous'; needsBootstrap: boolean }
  | { kind: 'authenticated'; member: Member };

export function App() {
  const [auth, setAuth] = useState<Auth>({ kind: 'loading' });

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
    const inviteMatch = window.location.pathname.match(/^\/invite\/([^/]+)$/);
    if (inviteMatch) {
      setAuth({ kind: 'invite', code: decodeURIComponent(inviteMatch[1]) });
      return;
    }
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

function AuthenticatedApp({ member, onLoggedOut }: { member: Member; onLoggedOut: () => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [tab, setTab] = useState<Tab>('equipments');
  const [usageEquipmentId, setUsageEquipmentId] = useState<string | null>(null);
  const [discussionEquipmentId, setDiscussionEquipmentId] = useState<string | null>(null);
  const [discussionThreadId, setDiscussionThreadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openUsageFor = useCallback((equipmentId: string) => {
    setUsageEquipmentId(equipmentId);
    setTab('usage');
  }, []);

  /** Navigue depuis un lien de notification (`/?tab=discussions&equipment=e1`). */
  const navigateTo = useCallback((link: string) => {
    try {
      const url = new URL(link, window.location.origin);
      const target = url.searchParams.get('tab') as Tab | null;
      const equipment = url.searchParams.get('equipment');
      if (!target || !TABS.some((t) => t.id === target)) return;
      if (target === 'usage' && equipment) setUsageEquipmentId(equipment);
      if (target === 'discussions') {
        if (equipment) setDiscussionEquipmentId(equipment);
        setDiscussionThreadId(url.searchParams.get('thread'));
      }
      setTab(target);
    } catch {
      /* lien invalide */
    }
  }, []);

  const loadMembers = useCallback(async () => {
    try {
      setMembers(await api.listMembers());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur de chargement.');
    }
  }, []);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  // Deep link initial (ouverture via un lien de notification).
  useEffect(() => {
    if (window.location.search.includes('tab=')) navigateTo(window.location.href);
  }, [navigateTo]);

  // Push natif (FCM) + clics de notification Web Push relayés par le service worker.
  useEffect(() => {
    void setupNativePush(navigateTo);
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'notification-click' && typeof e.data.link === 'string') navigateTo(e.data.link);
    };
    sw.addEventListener('message', onMessage);
    return () => sw.removeEventListener('message', onMessage);
  }, [navigateTo]);

  async function logout() {
    try {
      await api.logout();
    } finally {
      onLoggedOut();
    }
  }

  if (members === null) {
    return <p className="empty">Chargement…</p>;
  }

  return (
    <>
      <header className="topbar">
        <h1>🚜 ShareMate</h1>
        <div className="who">
          <NotificationBell onNavigate={navigateTo} />
          <UserMenu member={member} onLogout={() => void logout()} />
        </div>
      </header>

      {error && (
        <div className="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'equipments' && (
        <EquipmentsPage members={members} currentMemberId={member.id} onMembersChanged={() => void loadMembers()} />
      )}
      {tab === 'calendar' && (
        <CalendarPage members={members} currentMemberId={member.id} onRecordUsage={openUsageFor} />
      )}
      {tab === 'usage' && (
        <UsagePage members={members} currentMemberId={member.id} initialEquipmentId={usageEquipmentId} />
      )}
      {tab === 'expenses' && <ExpensesPage members={members} currentMemberId={member.id} />}
      {tab === 'discussions' && (
        <DiscussionsPage
          members={members}
          currentMemberId={member.id}
          initialEquipmentId={discussionEquipmentId}
          initialThreadId={discussionThreadId}
        />
      )}
    </>
  );
}
