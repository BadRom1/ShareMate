import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { AppNotification, NotificationPreference } from '../api';
import { NOTIFICATION_LABELS, formatRelative } from '../format';
import { enableWebPush, webPushPermission } from '../notifications';
import { errorMessage } from '../useApiResource';
import { ConfirmDialog } from './ConfirmDialog';
import { IconBell, IconClose } from './icons';

interface Props {
  /** Navigation demandée au clic sur une notification (lien `/?tab=...`). */
  onNavigate: (link: string) => void;
}

const POLL_INTERVAL_MS = 30_000;

/** Cloche de notifications : badge non-lus, panneau de liste et réglages des préférences. */
export function NotificationBell({ onNavigate }: Props) {
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [showPrefs, setShowPrefs] = useState(false);
  const [prefs, setPrefs] = useState<NotificationPreference[]>([]);
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const refreshCount = useCallback(async () => {
    try {
      setCount((await api.unreadCount()).count);
    } catch {
      /* hors-ligne : on réessaiera au prochain tick */
    }
  }, []);

  /** Recharge la liste depuis le serveur : seule version qui fasse foi après un échec d'écriture. */
  const reload = useCallback(async () => {
    try {
      setItems(await api.listNotifications());
    } catch {
      /* hors-ligne : la liste affichée reste celle du dernier chargement */
    }
  }, []);

  useEffect(() => {
    void refreshCount();
    const timer = setInterval(() => void refreshCount(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshCount]);

  /*
   * Ferme le panneau au clic extérieur — sauf pendant la confirmation d'un vidage : la boîte vit
   * dans un portail hors du panneau, et sans cette garde le clic sur « Annuler » comme sur
   * « Tout effacer » refermait le panneau derrière elle, faisant disparaître la boîte elle-même.
   */
  useEffect(() => {
    if (!open || confirmClear) return;
    function onClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open, confirmClear]);

  async function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) {
      setShowPrefs(false);
      setError(null);
      await reload();
    }
  }

  async function openItem(n: AppNotification) {
    if (!n.readAt) {
      try {
        await api.markNotificationRead(n.id);
        await refreshCount();
      } catch {
        /* ignoré */
      }
    }
    setOpen(false);
    if (n.link) onNavigate(n.link);
  }

  async function markAll() {
    await api.markAllNotificationsRead();
    await refreshCount();
    await reload();
  }

  /**
   * Écarte une notification. Le retrait est immédiat, sans attendre le serveur : le geste est un
   * rangement, et une liste qui ne bouge pas se relit comme un clic manqué. Si l'appel échoue, la
   * liste du serveur reprend la main — la ligne réapparaît plutôt que de mentir sur son sort.
   */
  async function dismiss(n: AppNotification) {
    setError(null);
    setItems((prev) => prev.filter((item) => item.id !== n.id));
    try {
      await api.dismissNotification(n.id);
      if (!n.readAt) await refreshCount();
    } catch (e) {
      setError(errorMessage(e));
      await reload();
    }
  }

  async function clearAll() {
    setClearing(true);
    setError(null);
    try {
      await api.dismissAllNotifications();
      setItems([]);
      await refreshCount();
    } catch (e) {
      setError(errorMessage(e));
      await reload();
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  }

  async function openPrefs() {
    setShowPrefs(true);
    setPrefs(await api.notificationPreferences());
  }

  function togglePref(index: number, channel: 'inApp' | 'push') {
    setPrefs((prev) => prev.map((p, i) => (i === index ? { ...p, [channel]: !p[channel] } : p)));
  }

  async function savePrefs() {
    setPrefs(await api.updateNotificationPreferences(prefs));
    setShowPrefs(false);
  }

  async function activatePush() {
    setPushMsg(null);
    const ok = await enableWebPush();
    setPushMsg(
      ok
        ? 'Notifications push activées sur cet appareil.'
        : "Impossible d'activer le push (permission refusée ou non configuré).",
    );
  }

  const pushPermission = webPushPermission();

  return (
    <div className="bell" ref={panelRef}>
      <button
        className={`bell-button ${count > 0 ? 'bell-active' : ''}`}
        onClick={() => void toggleOpen()}
        aria-label="Notifications"
      >
        <IconBell size={22} />
        {count > 0 && <span className="bell-badge">{count > 99 ? '99+' : count}</span>}
      </button>

      {open && (
        <div className="bell-panel">
          {showPrefs ? (
            <>
              <div className="bell-head">
                <strong>Préférences</strong>
                <button className="link" onClick={() => setShowPrefs(false)}>
                  ← Retour
                </button>
              </div>
              <table className="pref-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>App</th>
                    <th>Push</th>
                  </tr>
                </thead>
                <tbody>
                  {prefs.map((p, i) => (
                    <tr key={p.type}>
                      <td>{NOTIFICATION_LABELS[p.type] ?? p.type}</td>
                      <td>
                        <input type="checkbox" checked={p.inApp} onChange={() => togglePref(i, 'inApp')} />
                      </td>
                      <td>
                        <input type="checkbox" checked={p.push} onChange={() => togglePref(i, 'push')} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pushPermission !== 'unsupported' && pushPermission !== 'granted' && (
                <button className="ghost" onClick={() => void activatePush()}>
                  Activer le push sur cet appareil
                </button>
              )}
              {pushMsg && <p className="muted">{pushMsg}</p>}
              <button onClick={() => void savePrefs()}>Enregistrer</button>
            </>
          ) : (
            <>
              <div className="bell-head">
                <strong>Notifications</strong>
                <div className="row" style={{ gap: '0.5rem' }}>
                  {count > 0 && (
                    <button className="link" onClick={() => void markAll()}>
                      Tout lire
                    </button>
                  )}
                  {items.length > 0 && (
                    <button className="link link-danger" onClick={() => setConfirmClear(true)}>
                      Tout effacer
                    </button>
                  )}
                  <button className="link" onClick={() => void openPrefs()} aria-label="Préférences">
                    ⚙︎
                  </button>
                </div>
              </div>
              {error && (
                <div className="alert" onClick={() => setError(null)}>
                  {error}
                </div>
              )}
              {items.length === 0 ? (
                <p className="empty">Aucune notification.</p>
              ) : (
                <ul className="notif-list">
                  {items.map((n) => (
                    <li key={n.id} className={n.readAt ? 'notif' : 'notif notif-unread'}>
                      <button className="notif-item" onClick={() => void openItem(n)}>
                        <span className="notif-title">{n.title}</span>
                        <span className="notif-body">{n.body}</span>
                        <span className="muted notif-time">{formatRelative(n.createdAt)}</span>
                      </button>
                      <button
                        className="icon-btn notif-dismiss"
                        onClick={() => void dismiss(n)}
                        title="Effacer"
                        aria-label={`Effacer la notification « ${n.title} »`}
                      >
                        <IconClose size={16} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {confirmClear && (
                <ConfirmDialog
                  title="Effacer toutes les notifications ?"
                  confirmLabel="Tout effacer"
                  busy={clearing}
                  onConfirm={() => void clearAll()}
                  onCancel={() => setConfirmClear(false)}
                >
                  <p style={{ margin: 0 }}>
                    {items.length === 1
                      ? 'La notification de votre centre disparaîtra.'
                      : `Les ${items.length} notifications de votre centre disparaîtront, lues comme non lues.`}
                  </p>
                  <p className="muted" style={{ margin: 0 }}>
                    Seul votre affichage est vidé : les messages, dépenses et réservations annoncés restent en place,
                    comme les notifications des autres membres.
                  </p>
                </ConfirmDialog>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
