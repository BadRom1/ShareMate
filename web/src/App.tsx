import { useCallback, useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api';
import type { Member } from './api';
import { EquipmentsPage } from './pages/EquipmentsPage';
import { CalendarPage } from './pages/CalendarPage';
import { UsagePage } from './pages/UsagePage';
import { ExpensesPage } from './pages/ExpensesPage';
import { BootstrapPage, InvitePage, LoginPage } from './pages/AuthPages';

type Tab = 'equipments' | 'calendar' | 'usage' | 'expenses';

const TABS: { id: Tab; label: string }[] = [
  { id: 'equipments', label: 'Équipements' },
  { id: 'calendar', label: 'Calendrier' },
  { id: 'usage', label: 'Usage & entretien' },
  { id: 'expenses', label: 'Dépenses & soldes' },
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
  const [error, setError] = useState<string | null>(null);

  const openUsageFor = useCallback((equipmentId: string) => {
    setUsageEquipmentId(equipmentId);
    setTab('usage');
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
          <span>
            Connecté : <strong>{member.name}</strong>
          </span>
          <button className="ghost" onClick={() => void logout()}>
            Déconnexion
          </button>
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
    </>
  );
}
