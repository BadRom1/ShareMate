import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Equipment, Member, Message } from '../api';
import { formatDateTime } from '../format';

interface Props {
  members: Member[];
  currentMemberId: string;
  /** Équipement présélectionné (ex. arrivée depuis une notification). */
  initialEquipmentId?: string | null;
}

/** Fil de discussion par équipement. */
export function DiscussionsPage({ members, currentMemberId, initialEquipmentId }: Props) {
  const [equipments, setEquipments] = useState<Equipment[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  const selected = equipments.find((e) => e.id === selectedId) ?? null;
  const circle = useMemo(
    () => (selected ? members.filter((m) => selected.memberIds.includes(m.id)) : []),
    [selected, members],
  );
  const inCircle = selected?.memberIds.includes(currentMemberId) ?? false;

  const loadEquipments = useCallback(async () => {
    const list = await api.listEquipments();
    setEquipments(list);
    setSelectedId(
      (id) =>
        id || initialEquipmentId || list.find((e) => e.memberIds.includes(currentMemberId))?.id || list[0]?.id || '',
    );
  }, [currentMemberId, initialEquipmentId]);

  const loadMessages = useCallback(async () => {
    if (!selectedId) return;
    setMessages(await api.listMessages(selectedId));
  }, [selectedId]);

  useEffect(() => {
    loadEquipments().catch((e: Error) => setError(e.message));
  }, [loadEquipments]);

  useEffect(() => {
    loadMessages().catch((e: Error) => setError(e.message));
  }, [loadMessages]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages]);

  function memberName(id: string) {
    return members.find((m) => m.id === id)?.name ?? id;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !selectedId) return;
    setError(null);
    setBusy(true);
    try {
      await api.postMessage(selectedId, body);
      setDraft('');
      await loadMessages();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(message: Message) {
    if (!confirm('Supprimer ce message ?')) return;
    try {
      await api.deleteMessage(message.id);
      await loadMessages();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur.');
    }
  }

  if (equipments.length === 0) {
    return (
      <>
        {error && <div className="alert">{error}</div>}
        <p className="empty">Créez d'abord un équipement : chaque équipement a son fil de discussion.</p>
      </>
    );
  }

  return (
    <>
      {error && (
        <div className="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      <div className="card">
        <div className="row" style={{ alignItems: 'center' }}>
          <label className="field" style={{ flex: '0 0 auto', minWidth: '16rem' }}>
            Équipement
            <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
              {equipments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <p className="muted" style={{ margin: 0 }}>
              Cercle : {circle.map((m) => m.name).join(', ')}
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <h3>Discussion {selected ? `— ${selected.name}` : ''}</h3>
        {messages.length === 0 ? (
          <p className="empty">Aucun message pour le moment. Lancez la discussion !</p>
        ) : (
          <ul className="message-list">
            {messages.map((m) => {
              const mine = m.authorId === currentMemberId;
              return (
                <li key={m.id} className={`message ${mine ? 'message-mine' : ''}`}>
                  <div className="message-meta">
                    <strong>{memberName(m.authorId)}</strong>
                    <span className="muted">{formatDateTime(m.createdAt)}</span>
                    {mine && (
                      <button className="link-danger" onClick={() => void remove(m)} aria-label="Supprimer le message">
                        Supprimer
                      </button>
                    )}
                  </div>
                  <p className="message-body">{m.body}</p>
                </li>
              );
            })}
            <div ref={listEndRef} />
          </ul>
        )}

        {inCircle ? (
          <form onSubmit={submit} className="message-composer">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Écrire un message…"
              rows={2}
              maxLength={4000}
            />
            <button type="submit" disabled={busy || draft.trim().length === 0}>
              Envoyer
            </button>
          </form>
        ) : (
          <p className="muted">Vous ne faites pas partie du cercle de cet équipement : lecture seule.</p>
        )}
      </div>
    </>
  );
}
