import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { Member } from './api';
import { EquipmentsPage } from './pages/EquipmentsPage';
import { CalendarPage } from './pages/CalendarPage';
import { UsagePage } from './pages/UsagePage';
import { ExpensesPage } from './pages/ExpensesPage';

type Tab = 'equipments' | 'calendar' | 'usage' | 'expenses';

const TABS: { id: Tab; label: string }[] = [
  { id: 'equipments', label: 'Équipements' },
  { id: 'calendar', label: 'Calendrier' },
  { id: 'usage', label: 'Usage & entretien' },
  { id: 'expenses', label: 'Dépenses & soldes' },
];

export function App() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [memberId, setMemberId] = useState<string | null>(() => localStorage.getItem('sharemate.memberId'));
  const [tab, setTab] = useState<Tab>('equipments');
  const [usageEquipmentId, setUsageEquipmentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openUsageFor = useCallback((equipmentId: string) => {
    setUsageEquipmentId(equipmentId);
    setTab('usage');
  }, []);

  const loadMembers = useCallback(async () => {
    try {
      const list = await api.listMembers();
      setMembers(list);
      if (list.length > 0 && (!memberId || !list.some((m) => m.id === memberId))) {
        setMemberId(list[0].id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur de chargement.');
    }
  }, [memberId]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  useEffect(() => {
    if (memberId) localStorage.setItem('sharemate.memberId', memberId);
  }, [memberId]);

  if (members === null) {
    return <p className="empty">Chargement…</p>;
  }

  if (members.length === 0) {
    return <Onboarding onCreated={() => void loadMembers()} />;
  }

  if (!memberId) {
    return <p className="empty">Chargement…</p>;
  }

  return (
    <>
      <header className="topbar">
        <h1>🚜 ShareMate</h1>
        <div className="who">
          <span>Je suis :</span>
          <select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
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
        <EquipmentsPage members={members} currentMemberId={memberId} onMembersChanged={() => void loadMembers()} />
      )}
      {tab === 'calendar' && (
        <CalendarPage members={members} currentMemberId={memberId} onRecordUsage={openUsageFor} />
      )}
      {tab === 'usage' && (
        <UsagePage members={members} currentMemberId={memberId} initialEquipmentId={usageEquipmentId} />
      )}
      {tab === 'expenses' && <ExpensesPage members={members} currentMemberId={memberId} />}
    </>
  );
}

function Onboarding({ onCreated }: { onCreated: () => void }) {
  const [memberNames, setMemberNames] = useState(['', '']);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const names = memberNames.map((n) => n.trim()).filter(Boolean);
    if (names.length === 0) {
      setError('Ajoutez au moins une personne.');
      return;
    }
    setBusy(true);
    try {
      for (const name of names) {
        await api.createMember({ name });
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: '3rem' }}>
      <h2>🚜 Bienvenue sur ShareMate</h2>
      <p className="muted">
        Ici, ce sont les objets qui portent leurs utilisateurs : chaque équipement a son propre cercle de
        partage (réservations, suivi d'usage, frais). Commencez par créer les personnes, puis ajoutez vos
        équipements en choisissant qui les partage.
      </p>
      {error && <div className="alert">{error}</div>}
      <form className="stack" onSubmit={submit}>
        <span className="muted">Personnes (vous et ceux avec qui vous partagez)</span>
        {memberNames.map((n, i) => (
          <input
            key={i}
            value={n}
            onChange={(e) => setMemberNames(memberNames.map((v, j) => (j === i ? e.target.value : v)))}
            placeholder={`Personne ${i + 1}`}
          />
        ))}
        <button type="button" className="ghost" onClick={() => setMemberNames([...memberNames, ''])}>
          + Ajouter une personne
        </button>
        <button className="primary" disabled={busy}>
          C'est parti
        </button>
      </form>
    </div>
  );
}
