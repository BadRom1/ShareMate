import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { Group, GroupDetail } from './api';
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
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [groupId, setGroupId] = useState<string | null>(() => localStorage.getItem('sharemate.groupId'));
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [memberId, setMemberId] = useState<string | null>(() => localStorage.getItem('sharemate.memberId'));
  const [tab, setTab] = useState<Tab>('equipments');
  const [usageEquipmentId, setUsageEquipmentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openUsageFor = useCallback((equipmentId: string) => {
    setUsageEquipmentId(equipmentId);
    setTab('usage');
  }, []);

  const loadGroups = useCallback(async () => {
    try {
      const list = await api.listGroups();
      setGroups(list);
      if (list.length > 0 && (!groupId || !list.some((g) => g.id === groupId))) {
        setGroupId(list[0].id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur de chargement.');
    }
  }, [groupId]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    if (!groupId) {
      setGroup(null);
      return;
    }
    localStorage.setItem('sharemate.groupId', groupId);
    api
      .getGroup(groupId)
      .then((g) => {
        setGroup(g);
        if (!g.members.some((m) => m.id === localStorage.getItem('sharemate.memberId'))) {
          setMemberId(g.members[0]?.id ?? null);
        }
      })
      .catch((e: Error) => setError(e.message));
  }, [groupId]);

  useEffect(() => {
    if (memberId) localStorage.setItem('sharemate.memberId', memberId);
  }, [memberId]);

  const refreshGroup = useCallback(() => {
    if (groupId) {
      api.getGroup(groupId).then(setGroup).catch(() => undefined);
    }
  }, [groupId]);

  if (groups === null) {
    return <p className="empty">Chargement…</p>;
  }

  if (groups.length === 0) {
    return <Onboarding onCreated={() => void loadGroups()} />;
  }

  if (!group || !memberId) {
    return <p className="empty">Chargement du groupe…</p>;
  }

  return (
    <>
      <header className="topbar">
        <h1>🚜 ShareMate</h1>
        <span className="badge">{group.name}</span>
        <div className="who">
          <span>Je suis :</span>
          <select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
            {group.members.map((m) => (
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

      {tab === 'equipments' && <EquipmentsPage group={group} onGroupChanged={refreshGroup} />}
      {tab === 'calendar' && (
        <CalendarPage group={group} currentMemberId={memberId} onRecordUsage={openUsageFor} />
      )}
      {tab === 'usage' && (
        <UsagePage group={group} currentMemberId={memberId} initialEquipmentId={usageEquipmentId} />
      )}
      {tab === 'expenses' && <ExpensesPage group={group} currentMemberId={memberId} />}
    </>
  );
}

function Onboarding({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [memberNames, setMemberNames] = useState(['', '']);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const members = memberNames.map((n) => n.trim()).filter(Boolean);
    if (members.length === 0) {
      setError('Ajoutez au moins un membre.');
      return;
    }
    setBusy(true);
    try {
      await api.createGroup({ name, members: members.map((n) => ({ name: n })) });
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
        Créez votre collectif pour gérer ensemble votre matériel partagé : réservations, suivi d'usage et
        partage des frais.
      </p>
      {error && <div className="alert">{error}</div>}
      <form className="stack" onSubmit={submit}>
        <label className="field">
          Nom du groupe
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Les voisins de la Combe" required />
        </label>
        <span className="muted">Membres (2 à 5 personnes)</span>
        {memberNames.map((n, i) => (
          <input
            key={i}
            value={n}
            onChange={(e) => setMemberNames(memberNames.map((v, j) => (j === i ? e.target.value : v)))}
            placeholder={`Membre ${i + 1}`}
          />
        ))}
        {memberNames.length < 5 && (
          <button type="button" className="ghost" onClick={() => setMemberNames([...memberNames, ''])}>
            + Ajouter un membre
          </button>
        )}
        <button className="primary" disabled={busy}>
          Créer le groupe
        </button>
      </form>
    </div>
  );
}
