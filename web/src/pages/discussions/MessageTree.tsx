import { useEffect, useMemo, useRef, useState } from 'react';
import type { Member, Message } from '../../api';
import { formatDateTime } from '../../format';
import { IconCheck, IconClose, IconEdit, IconReply, IconSend, IconTrash } from '../../components/icons';

interface Props {
  messages: Message[];
  members: Member[];
  currentMemberId: string;
  /** Hors cercle : lecture seule (ni réponse, ni édition). */
  inCircle: boolean;
  /** Une écriture est en cours : les envois sont désarmés le temps de la réponse du serveur. */
  busy: boolean;
  onReply: (parentId: string, body: string) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

/**
 * Arbre des messages d'un fil (style Slack/Reddit) et ses gestes de rédaction.
 *
 * Le composant porte l'état d'interaction — quel message est en cours d'édition, à quel message on
 * répond, quels sous-fils sont repliés —, jamais les données : elles arrivent en `messages` et les
 * écritures repartent en rappels. C'est ce qui permet de le sortir de la page sans traîner derrière
 * lui cinq états et leurs remises à zéro : changer de fil suffit à le démonter, et l'arbre repart
 * d'une vue propre.
 */
export function MessageTree({ messages, members, currentMemberId, inCircle, busy, onReply, onEdit, onDelete }: Props) {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const listEndRef = useRef<HTMLDivElement | null>(null);

  // Enfants indexés par identifiant du message parent : la racine est la clé `null`.
  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, Message[]>();
    for (const m of messages) {
      const key = m.parentId ?? null;
      const siblings = map.get(key) ?? [];
      siblings.push(m);
      map.set(key, siblings);
    }
    return map;
  }, [messages]);

  // Le bas du fil reste visible à l'arrivée d'un message.
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages]);

  function memberName(id: string) {
    return members.find((m) => m.id === id)?.name ?? id;
  }

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function startReply(id: string) {
    setEditingMessageId(null);
    setReplyDraft('');
    setReplyingTo(id);
  }

  async function submitReply(parentId: string) {
    const body = replyDraft.trim();
    if (!body) return;
    // Le sous-fil du parent est déplié d'avance : sinon la réponse tout juste écrite est masquée.
    setCollapsed((prev) => {
      if (!prev.has(parentId)) return prev;
      const next = new Set(prev);
      next.delete(parentId);
      return next;
    });
    await onReply(parentId, body);
    setReplyDraft('');
    setReplyingTo(null);
  }

  async function submitEdit(id: string) {
    const body = editDraft.trim();
    if (!body) return;
    await onEdit(id, body);
    setEditingMessageId(null);
  }

  function renderMessage(m: Message) {
    const mine = m.authorId === currentMemberId;
    const editing = editingMessageId === m.id;
    const replying = replyingTo === m.id;
    const replies = childrenByParent.get(m.id) ?? [];
    const isCollapsed = collapsed.has(m.id);
    return (
      <li key={m.id} className="msg-node">
        <div className={`message ${mine ? 'message-mine' : ''}`}>
          <div className="message-meta">
            <strong>{memberName(m.authorId)}</strong>
            <span className="muted">
              {formatDateTime(m.createdAt)}
              {m.editedAt ? ' · modifié' : ''}
            </span>
            {!editing && (
              <span className="message-actions">
                {inCircle && (
                  <button className="icon-btn icon-edit" onClick={() => startReply(m.id)} title="Répondre">
                    <IconReply size={16} />
                  </button>
                )}
                {mine && (
                  <>
                    <button
                      className="icon-btn icon-edit"
                      onClick={() => {
                        setReplyingTo(null);
                        setEditingMessageId(m.id);
                        setEditDraft(m.body);
                      }}
                      title="Modifier"
                    >
                      <IconEdit size={16} />
                    </button>
                    <button className="icon-btn icon-danger" onClick={() => void onDelete(m.id)} title="Supprimer">
                      <IconTrash size={16} />
                    </button>
                  </>
                )}
              </span>
            )}
          </div>
          {editing ? (
            <form
              className="message-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void submitEdit(m.id);
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
              <button type="button" className="icon-btn" onClick={() => setEditingMessageId(null)} title="Annuler">
                <IconClose size={18} />
              </button>
            </form>
          ) : (
            <p className="message-body">{m.body}</p>
          )}
          {replies.length > 0 && (
            <button className="link reply-toggle" onClick={() => toggleCollapse(m.id)}>
              {isCollapsed
                ? `▸ Afficher ${replies.length} réponse${replies.length > 1 ? 's' : ''}`
                : `▾ Masquer les réponses`}
            </button>
          )}
        </div>

        {replying && inCircle && (
          <form
            className="message-composer reply-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void submitReply(m.id);
            }}
          >
            <textarea
              value={replyDraft}
              onChange={(e) => setReplyDraft(e.target.value)}
              placeholder={`Répondre à ${memberName(m.authorId)}…`}
              rows={2}
              maxLength={4000}
              autoFocus
            />
            <button
              type="submit"
              className="icon-btn icon-primary"
              disabled={busy || replyDraft.trim().length === 0}
              title="Envoyer la réponse"
              aria-label="Envoyer la réponse"
            >
              <IconSend size={18} />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setReplyingTo(null)}
              title="Annuler"
              aria-label="Annuler"
            >
              <IconClose size={18} />
            </button>
          </form>
        )}

        {replies.length > 0 && !isCollapsed && (
          <ul className="message-branch">{replies.map((child) => renderMessage(child))}</ul>
        )}
      </li>
    );
  }

  if (messages.length === 0) {
    return <p className="empty">Aucun message. Écrivez le premier ci-dessous.</p>;
  }
  return (
    <div className="message-tree">
      <ul className="message-branch">{(childrenByParent.get(null) ?? []).map((m) => renderMessage(m))}</ul>
      <div ref={listEndRef} />
    </div>
  );
}
