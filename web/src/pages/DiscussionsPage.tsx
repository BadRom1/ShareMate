import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Equipment, Member, Message, ThreadSummary } from '../api';
import { formatDateTime, formatRelative } from '../format';
import { IconBack, IconChat, IconCheck, IconClose, IconEdit, IconPlus, IconSend, IconTrash } from '../components/icons';

interface Props {
  members: Member[];
  currentMemberId: string;
  /** Équipement présélectionné (arrivée depuis une notification). */
  initialEquipmentId?: string | null;
  /** Fil à ouvrir automatiquement (arrivée depuis une notification). */
  initialThreadId?: string | null;
}

/** Discussions par équipement : liste de fils, puis vue d'un fil avec ses messages. */
export function DiscussionsPage({ members, currentMemberId, initialEquipmentId, initialThreadId }: Props) {
  const [equipments, setEquipments] = useState<Equipment[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [openThreadId, setOpenThreadId] = useState<string | null>(initialThreadId ?? null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Formulaire de nouveau fil.
  const [showNewThread, setShowNewThread] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');

  // Édition inline (message ou titre de fil).
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [renamingThread, setRenamingThread] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');

  const [draft, setDraft] = useState('');
  const listEndRef = useRef<HTMLDivElement | null>(null);

  const selected = equipments.find((e) => e.id === selectedId) ?? null;
  const inCircle = selected?.memberIds.includes(currentMemberId) ?? false;
  const openThread = threads.find((t) => t.id === openThreadId) ?? null;
  const circle = useMemo(
    () => (selected ? members.filter((m) => selected.memberIds.includes(m.id)) : []),
    [selected, members],
  );

  const loadEquipments = useCallback(async () => {
    const list = await api.listEquipments();
    setEquipments(list);
    setSelectedId(
      (id) =>
        id || initialEquipmentId || list.find((e) => e.memberIds.includes(currentMemberId))?.id || list[0]?.id || '',
    );
  }, [currentMemberId, initialEquipmentId]);

  const loadThreads = useCallback(async () => {
    if (!selectedId) return;
    setThreads(await api.listThreads(selectedId));
  }, [selectedId]);

  const loadMessages = useCallback(async () => {
    if (!openThreadId) return;
    setMessages(await api.listMessages(openThreadId));
  }, [openThreadId]);

  useEffect(() => {
    loadEquipments().catch((e: Error) => setError(e.message));
  }, [loadEquipments]);

  useEffect(() => {
    loadThreads().catch((e: Error) => setError(e.message));
  }, [loadThreads]);

  useEffect(() => {
    if (openThreadId) loadMessages().catch((e: Error) => setError(e.message));
  }, [openThreadId, loadMessages]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages]);

  // Changement d'équipement : on referme le fil ouvert.
  useEffect(() => {
    setOpenThreadId(null);
  }, [selectedId]);

  // Échap ferme la modale de création.
  useEffect(() => {
    if (!showNewThread) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowNewThread(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showNewThread]);

  function memberName(id: string) {
    return members.find((m) => m.id === id)?.name ?? id;
  }

  function fail(e: unknown) {
    setError(e instanceof Error ? e.message : 'Erreur.');
  }

  async function createThread(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedId || !newTitle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const thread = await api.createThread(selectedId, newTitle.trim(), newBody.trim() || undefined);
      setNewTitle('');
      setNewBody('');
      setShowNewThread(false);
      await loadThreads();
      setOpenThreadId(thread.id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function removeThread(id: string) {
    if (!confirm('Supprimer ce fil et tous ses messages ?')) return;
    try {
      await api.deleteThread(id);
      if (openThreadId === id) setOpenThreadId(null);
      await loadThreads();
    } catch (e) {
      fail(e);
    }
  }

  async function saveRename() {
    if (!openThread || !renameDraft.trim()) return;
    try {
      await api.renameThread(openThread.id, renameDraft.trim());
      setRenamingThread(false);
      await loadThreads();
    } catch (e) {
      fail(e);
    }
  }

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !openThreadId) return;
    setBusy(true);
    setError(null);
    try {
      await api.postMessage(openThreadId, body);
      setDraft('');
      await Promise.all([loadMessages(), loadThreads()]);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: string) {
    if (!editDraft.trim()) return;
    try {
      await api.editMessage(id, editDraft.trim());
      setEditingMessageId(null);
      await loadMessages();
    } catch (e) {
      fail(e);
    }
  }

  async function removeMessage(id: string) {
    if (!confirm('Supprimer ce message ?')) return;
    try {
      await api.deleteMessage(id);
      await Promise.all([loadMessages(), loadThreads()]);
    } catch (e) {
      fail(e);
    }
  }

  if (equipments.length === 0) {
    return (
      <>
        {error && <div className="alert">{error}</div>}
        <p className="empty">Créez d'abord un équipement : chaque équipement a ses fils de discussion.</p>
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

      <div className={`discussion-layout ${openThread ? 'has-open' : ''}`}>
        <div className="discussion-main">
          {openThread ? (
            ThreadView()
          ) : (
            <div className="card empty-pane">
              <IconChat size={40} />
              <p className="empty" style={{ margin: 0 }}>
                Sélectionnez un fil à droite{inCircle ? ' ou créez-en un' : ''}.
              </p>
            </div>
          )}
        </div>

        <aside className="discussion-aside">
          <div className="card">
            <div className="bell-head">
              <h3 style={{ margin: 0 }}>Fils{selected ? ` — ${selected.name}` : ''}</h3>
              {inCircle && (
                <button className="btn-primary btn-icon-text" onClick={() => setShowNewThread(true)}>
                  <IconPlus size={18} /> Nouveau
                </button>
              )}
            </div>

            {threads.length === 0 ? (
              <p className="empty">Aucun fil{inCircle ? ' — ouvrez le premier !' : '.'}</p>
            ) : (
              <ul className="thread-list">
                {threads.map((t) => (
                  <li key={t.id} className={`thread-row ${t.id === openThreadId ? 'thread-active' : ''}`}>
                    <button className="thread-open" onClick={() => setOpenThreadId(t.id)}>
                      <IconChat size={18} />
                      <span className="thread-titles">
                        <span className="thread-title">{t.title}</span>
                        <span className="muted thread-sub">
                          {memberName(t.authorId)} · {t.messageCount} msg · {formatRelative(t.updatedAt)}
                        </span>
                      </span>
                    </button>
                    {t.authorId === currentMemberId && (
                      <button
                        className="icon-btn icon-danger"
                        onClick={() => void removeThread(t.id)}
                        title="Supprimer le fil"
                      >
                        <IconTrash size={18} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      {showNewThread && inCircle && (
        <div className="modal-backdrop" onClick={() => setShowNewThread(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3 style={{ margin: 0 }}>Nouveau fil de discussion</h3>
              <button className="icon-btn" onClick={() => setShowNewThread(false)} title="Fermer">
                <IconClose size={20} />
              </button>
            </div>
            <form onSubmit={createThread} className="modal-form">
              <label className="field">
                Titre
                <input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="ex. Panne moteur"
                  maxLength={200}
                  autoFocus
                />
              </label>
              <label className="field">
                Premier message <span className="muted">(optionnel)</span>
                <textarea
                  value={newBody}
                  onChange={(e) => setNewBody(e.target.value)}
                  placeholder="Décrivez le sujet…"
                  rows={4}
                  maxLength={4000}
                />
              </label>
              <div className="modal-actions">
                <button type="button" className="ghost" onClick={() => setShowNewThread(false)}>
                  Annuler
                </button>
                <button type="submit" className="btn-primary" disabled={busy || !newTitle.trim()}>
                  <IconCheck size={18} /> Créer le fil
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );

  function ThreadView() {
    if (!openThread) return null;
    const isAuthor = openThread.authorId === currentMemberId;
    return (
      <div className="card">
        <div className="bell-head">
          <button className="icon-btn thread-back" onClick={() => setOpenThreadId(null)} title="Retour aux fils">
            <IconBack size={20} />
          </button>
          {renamingThread ? (
            <form
              className="inline-edit"
              onSubmit={(e) => {
                e.preventDefault();
                void saveRename();
              }}
            >
              <input value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} maxLength={200} autoFocus />
              <button type="submit" className="icon-btn icon-confirm" title="Valider">
                <IconCheck size={18} />
              </button>
              <button type="button" className="icon-btn" onClick={() => setRenamingThread(false)} title="Annuler">
                <IconClose size={18} />
              </button>
            </form>
          ) : (
            <>
              <h3 style={{ margin: 0, flex: 1 }}>{openThread.title}</h3>
              {isAuthor && (
                <div className="icon-group">
                  <button
                    className="icon-btn icon-edit"
                    onClick={() => {
                      setRenameDraft(openThread.title);
                      setRenamingThread(true);
                    }}
                    title="Renommer le fil"
                  >
                    <IconEdit size={18} />
                  </button>
                  <button
                    className="icon-btn icon-danger"
                    onClick={() => void removeThread(openThread.id)}
                    title="Supprimer le fil"
                  >
                    <IconTrash size={18} />
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {messages.length === 0 ? (
          <p className="empty">Aucun message. Écrivez le premier ci-dessous.</p>
        ) : (
          <ul className="message-list">
            {messages.map((m) => {
              const mine = m.authorId === currentMemberId;
              const editing = editingMessageId === m.id;
              return (
                <li key={m.id} className={`message ${mine ? 'message-mine' : ''}`}>
                  <div className="message-meta">
                    <strong>{memberName(m.authorId)}</strong>
                    <span className="muted">
                      {formatDateTime(m.createdAt)}
                      {m.editedAt ? ' · modifié' : ''}
                    </span>
                    {mine && !editing && (
                      <span className="message-actions">
                        <button
                          className="icon-btn icon-edit"
                          onClick={() => {
                            setEditingMessageId(m.id);
                            setEditDraft(m.body);
                          }}
                          title="Modifier"
                        >
                          <IconEdit size={16} />
                        </button>
                        <button
                          className="icon-btn icon-danger"
                          onClick={() => void removeMessage(m.id)}
                          title="Supprimer"
                        >
                          <IconTrash size={16} />
                        </button>
                      </span>
                    )}
                  </div>
                  {editing ? (
                    <form
                      className="message-composer"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveEdit(m.id);
                      }}
                    >
                      <textarea
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        rows={2}
                        maxLength={4000}
                        autoFocus
                      />
                      <button type="submit" className="icon-btn icon-confirm" title="Enregistrer">
                        <IconCheck size={18} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => setEditingMessageId(null)}
                        title="Annuler"
                      >
                        <IconClose size={18} />
                      </button>
                    </form>
                  ) : (
                    <p className="message-body">{m.body}</p>
                  )}
                </li>
              );
            })}
            <div ref={listEndRef} />
          </ul>
        )}

        {inCircle ? (
          <form onSubmit={sendMessage} className="message-composer">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Écrire un message…"
              rows={2}
              maxLength={4000}
            />
            <button
              type="submit"
              className="btn-primary btn-icon"
              disabled={busy || draft.trim().length === 0}
              title="Envoyer"
            >
              <IconSend size={18} />
            </button>
          </form>
        ) : (
          <p className="muted">Vous ne faites pas partie du cercle de cet équipement : lecture seule.</p>
        )}
      </div>
    );
  }
}
