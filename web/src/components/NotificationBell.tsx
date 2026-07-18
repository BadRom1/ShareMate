import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { AppNotification, NotificationPreference } from '../api';
import { NOTIFICATION_LABELS, formatRelative } from '../format';
import { enableWebPush, webPushPermission } from '../notifications';
import { IconBell } from './icons';

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
  const panelRef = useRef<HTMLDivElement | null>(null);

  const refreshCount = useCallback(async () => {
    try {
      setCount((await api.unreadCount()).count);
    } catch {
      /* hors-ligne : on réessaiera au prochain tick */
    }
  }, []);

  useEffect(() => {
    void refreshCount();
    const timer = setInterval(() => void refreshCount(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshCount]);

  // Ferme le panneau au clic extérieur.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  async function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) {
      setShowPrefs(false);
      try {
        setItems(await api.listNotifications());
      } catch {
        /* ignoré */
      }
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
    setItems(await api.listNotifications());
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
                  <button className="link" onClick={() => void openPrefs()}>
                    ⚙︎
                  </button>
                </div>
              </div>
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
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
