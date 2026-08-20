import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Equipment, Member } from '../api';
import { formatRelative } from '../format';
import { clearErrors, errorMessage, firstError, useApiResource } from '../useApiResource';
import { IconBack, IconChat, IconCheck, IconClose, IconEdit, IconSend, IconTrash } from '../components/icons';
import { Modal } from '../components/Modal';
import { Fab } from '../components/Fab';
import { MessageTree } from './discussions/MessageTree';
import { AttachmentDraft, AttachmentField } from './discussions/AttachmentField';

interface Props {
  members: Member[];
  currentMemberId: string;
  /** Équipement de l'espace de travail courant, choisi dans la coque de l'application. */
  equipment: Equipment;
  /** Fil à ouvrir automatiquement (arrivée depuis une notification). */
  initialThreadId?: string | null;
}

/** Discussions de l'équipement courant : liste de fils, puis vue d'un fil avec ses messages. */
export function DiscussionsPage({ members, currentMemberId, equipment, initialThreadId }: Props) {
  const [openThreadId, setOpenThreadId] = useState<string | null>(initialThreadId ?? null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Formulaire de nouveau fil.
  const [showNewThread, setShowNewThread] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');

  // Renommage inline du titre du fil.
  const [renamingThread, setRenamingThread] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');

  const [draft, setDraft] = useState('');
  /** Fichier retenu pour le prochain message, tant qu'il n'est pas parti. */
  const [file, setFile] = useState<File | null>(null);

  const threadsResource = useApiResource(useCallback(() => api.listThreads(equipment.id), [equipment.id]));

  const messagesResource = useApiResource(
    useCallback(async () => (openThreadId ? api.listMessages(openThreadId) : []), [openThreadId]),
  );

  const threads = threadsResource.data ?? [];
  const messages = useMemo(() => messagesResource.data ?? [], [messagesResource.data]);
  const error = actionError ?? firstError(threadsResource, messagesResource);

  const inCircle = equipment.memberIds.includes(currentMemberId);
  const openThread = threads.find((t) => t.id === openThreadId) ?? null;
  const circle = useMemo(
    () => members.filter((m) => equipment.memberIds.includes(m.id)),
    [equipment.memberIds, members],
  );

  // Le fil ouvert appartient à l'équipement quitté : il se referme au changement d'espace.
  useEffect(() => {
    setOpenThreadId(null);
  }, [equipment.id]);

  // Fil ciblé par un lien de notification, y compris quand un second lien arrive alors que
  // l'onglet est déjà affiché : l'état initial ne suffit pas, le composant reste monté.
  useEffect(() => {
    if (initialThreadId) setOpenThreadId(initialThreadId);
  }, [initialThreadId]);

  function memberName(id: string) {
    return members.find((m) => m.id === id)?.name ?? id;
  }

  function fail(e: unknown) {
    setActionError(errorMessage(e));
  }

  async function createThread(event: React.FormEvent) {
    event.preventDefault();
    if (!newTitle.trim()) return;
    setBusy(true);
    setActionError(null);
    try {
      const thread = await api.createThread(equipment.id, newTitle.trim(), newBody.trim() || undefined);
      setNewTitle('');
      setNewBody('');
      setShowNewThread(false);
      await threadsResource.reload();
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
      await threadsResource.reload();
    } catch (e) {
      fail(e);
    }
  }

  async function saveRename() {
    if (!openThread || !renameDraft.trim()) return;
    try {
      await api.renameThread(openThread.id, renameDraft.trim());
      setRenamingThread(false);
      await threadsResource.reload();
    } catch (e) {
      fail(e);
    }
  }

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    // Un fichier seul fait un message : le texte n'est exigé que sans lui.
    if ((!body && !file) || !openThreadId) return;
    setBusy(true);
    setActionError(null);
    try {
      // Un fichier seul fait un message : le corps peut alors partir vide.
      if (file) await api.postMessageWithFile(openThreadId, file, { body });
      else await api.postMessage(openThreadId, body);
      setDraft('');
      setFile(null);
      await Promise.all([messagesResource.reload(), threadsResource.reload()]);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function sendReply(parentId: string, body: string, file: File | null) {
    if (!openThreadId) return;
    setBusy(true);
    setActionError(null);
    try {
      if (file) await api.postMessageWithFile(openThreadId, file, { body, parentId });
      else await api.postMessage(openThreadId, body, parentId);
      await Promise.all([messagesResource.reload(), threadsResource.reload()]);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function editMessage(id: string, body: string) {
    try {
      await api.editMessage(id, body);
      await messagesResource.reload();
    } catch (e) {
      fail(e);
    }
  }

  async function removeMessage(id: string) {
    if (!confirm('Supprimer ce message ?')) return;
    try {
      await api.deleteMessage(id);
      await Promise.all([messagesResource.reload(), threadsResource.reload()]);
    } catch (e) {
      fail(e);
    }
  }

  return (
    <>
      {error && (
        <div
          className="alert"
          onClick={() => {
            setActionError(null);
            clearErrors(threadsResource, messagesResource);
          }}
        >
          {error}
        </div>
      )}

      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          Cercle : {circle.map((m) => m.name).join(', ')}
        </p>
      </div>

      <div className={`split-layout ${openThread ? 'has-open' : ''}`}>
        <div className="split-main">
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

        <aside className="split-aside">
          <div className="card">
            <div className="bell-head">
              <h3
                style={{
                  margin: 0,
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={equipment.name}
              >
                {equipment.name}
              </h3>
            </div>

            {threads.length === 0 ? (
              <p className="empty">Aucun fil{inCircle ? ' — ouvrez le premier !' : '.'}</p>
            ) : (
              <ul className="side-list">
                {threads.map((t) => (
                  <li key={t.id} className={`side-row ${t.id === openThreadId ? 'side-active' : ''}`}>
                    <button className="side-open" onClick={() => setOpenThreadId(t.id)}>
                      <IconChat size={18} />
                      <span className="side-titles">
                        <span className="side-title">{t.title}</span>
                        <span className="muted side-sub">
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
        <Modal title="Nouveau fil de discussion" onClose={() => setShowNewThread(false)}>
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
        </Modal>
      )}

      {/* Seulement dans la liste : un fil ouvert a sa propre action principale — écrire un message —
          et le bouton flottant viendrait se poser juste sur celui d'envoi du composeur, en bas à
          droite lui aussi. Sur mobile la liste latérale est alors masquée, mais on y revient par le
          bouton retour, qui est de toute façon le geste pour quitter le fil. */}
      {inCircle && !openThread && <Fab label="Ouvrir un nouveau fil" onClick={() => setShowNewThread(true)} />}
    </>
  );

  function ThreadView() {
    if (!openThread) return null;
    const isAuthor = openThread.authorId === currentMemberId;

    return (
      <div className="card">
        <div className="bell-head">
          <button className="icon-btn side-back" onClick={() => setOpenThreadId(null)} title="Retour aux fils">
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

        {/* `key` : changer de fil démonte l'arbre, qui repart d'une vue propre — pas de réponse
            en cours, aucun sous-fil replié. Sans elle, il faudrait remettre son état à zéro depuis
            ici, sur un effet qui s'exécute aussi au montage. */}
        <MessageTree
          key={openThread.id}
          messages={messages}
          members={members}
          currentMemberId={currentMemberId}
          inCircle={inCircle}
          busy={busy}
          onReply={sendReply}
          onEdit={editMessage}
          onDelete={removeMessage}
        />

        {inCircle ? (
          <form onSubmit={sendMessage} className="message-composer">
            {file && <AttachmentDraft file={file} onClear={() => setFile(null)} />}
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Écrire un message…"
              rows={2}
              maxLength={4000}
            />
            <AttachmentField onPick={setFile} disabled={busy} label="Joindre un fichier au message" />
            <button
              type="submit"
              className="icon-btn icon-primary"
              disabled={busy || (draft.trim().length === 0 && !file)}
              title="Envoyer"
              aria-label="Envoyer"
            >
              <IconSend size={20} />
            </button>
          </form>
        ) : (
          <p className="muted">Vous ne faites pas partie du cercle de cet équipement : lecture seule.</p>
        )}
      </div>
    );
  }
}
