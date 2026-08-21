import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { AppNotification, NotificationPreference } from '../api';
import { NOTIFICATION_LABELS, formatRelative } from '../format';
import { enableWebPush, webPushPermission } from '../notifications';
import { useEscape } from '../useEscape';
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
  /** Rang de la ligne effacée, à qui rendre le focus une fois la liste redessinée. */
  const [focusRank, setFocusRank] = useState<number | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const prefsButtonRef = useRef<HTMLButtonElement | null>(null);

  const refreshCount = useCallback(async () => {
    try {
      setCount((await api.unreadCount()).count);
    } catch {
      /* hors-ligne : on réessaiera au prochain tick */
    }
  }, []);

  /**
   * Recharge la liste depuis le serveur — seule version qui fasse foi après un échec d'écriture.
   * Rend `false` si le serveur n'a pas répondu : l'appelant sait alors qu'il reste seul juge de
   * ce qu'il affiche, au lieu de croire qu'il vient d'être remis d'accord avec la base.
   */
  const reload = useCallback(async () => {
    try {
      setItems(await api.listNotifications());
      return true;
    } catch {
      return false;
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

  /*
   * Le panneau fermé ne garde rien : ni le message d'erreur du geste précédent, ni une
   * confirmation en cours. Sans cette remise à zéro, un panneau refermé pendant la confirmation
   * laissait `confirmClear` à vrai — la boîte revenait sans être demandée à la réouverture, et la
   * garde ci-dessous bloquait définitivement la fermeture au clic extérieur.
   */
  useEffect(() => {
    if (open) return;
    setConfirmClear(false);
    setError(null);
  }, [open]);

  /*
   * Rend le focus après un effacement : la croix de la ligne qui prend la place de celle qui
   * part, la dernière si c'était la fin de la liste, l'engrenage quand le centre se vide. Sans
   * cela le focus retombe sur `document.body` et le clavier repart du haut de la page à chaque
   * notification effacée.
   */
  useEffect(() => {
    if (focusRank === null) return;
    setFocusRank(null);
    const croix = listRef.current?.querySelectorAll<HTMLButtonElement>('.notif-dismiss');
    const cible = croix?.length ? croix[Math.min(focusRank, croix.length - 1)] : prefsButtonRef.current;
    cible?.focus();
  }, [focusRank, items]);

  // Échap referme le panneau — mais pas quand la confirmation est ouverte : le hook laisse la
  // main à la boîte de dialogue, sinon un seul appui emporterait les deux.
  useEscape(useCallback(() => setOpen(false), []));

  async function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) {
      setShowPrefs(false);
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
    setError(null);
    try {
      await api.markAllNotificationsRead();
      // Tout est lu : le badge vaut zéro, c'est une déduction, pas une question à reposer.
      setCount(0);
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /**
   * Écarte une notification. Le retrait est immédiat, sans attendre le serveur : le geste est un
   * rangement, et une liste qui ne bouge pas se relit comme un clic manqué. En cas d'échec la
   * ligne revient — celle du serveur si on l'a jointe, sinon celle qu'on affichait : la panne la
   * plus banale coupe les deux appels, et se taire alors afficherait un centre vide qui ne l'est
   * pas.
   */
  async function dismiss(n: AppNotification) {
    setError(null);
    const avant = items;
    setItems(avant.filter((item) => item.id !== n.id));
    setFocusRank(avant.findIndex((item) => item.id === n.id));
    try {
      await api.dismissNotification(n.id);
      // Une non-lue de moins : le badge suit sans second aller-retour, que le réseau se
      // dégrade ou non. Le sondage périodique corrigera ce que cette soustraction ignore.
      if (!n.readAt) setCount((c) => Math.max(0, c - 1));
    } catch (e) {
      setError(errorMessage(e));
      setItems(avant);
      await reload();
    }
  }

  async function clearAll() {
    setClearing(true);
    setError(null);
    try {
      await api.dismissAllNotifications();
      setItems([]);
      // Le centre est vide : plus rien à compter. Un `unreadCount` en échec laissait sinon un
      // badge chiffré au-dessus d'une liste vide, et un « Tout lire » qui ne lisait rien.
      setCount(0);
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
    setError(null);
    try {
      setPrefs(await api.notificationPreferences());
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function togglePref(index: number, channel: 'inApp' | 'push') {
    setPrefs((prev) => prev.map((p, i) => (i === index ? { ...p, [channel]: !p[channel] } : p)));
  }

  async function savePrefs() {
    setError(null);
    try {
      setPrefs(await api.updateNotificationPreferences(prefs));
      setShowPrefs(false);
    } catch (e) {
      setError(errorMessage(e));
    }
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
          {/* Le bandeau vit au-dessus des deux vues : une erreur d'effacement ne doit pas
              disparaître parce qu'on ouvre les préférences, ni revenir en quittant celles-ci. */}
          {error && (
            <div className="alert" role="alert" onClick={() => setError(null)}>
              {error}
            </div>
          )}
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
                  <button
                    className="link"
                    onClick={() => void openPrefs()}
                    aria-label="Préférences"
                    ref={prefsButtonRef}
                  >
                    ⚙︎
                  </button>
                </div>
              </div>
              {items.length === 0 ? (
                <p className="empty">Aucune notification.</p>
              ) : (
                <ul className="notif-list" ref={listRef}>
                  {items.map((n) => (
                    <li key={n.id} className={n.readAt ? 'notif' : 'notif notif-unread'}>
                      <button className="notif-item" onClick={() => void openItem(n)}>
                        <span className="notif-title">{n.title}</span>
                        <span className="notif-body">{n.body}</span>
                        <span className="muted notif-time">{formatRelative(n.createdAt)}</span>
                      </button>
                      <button
                        className="icon-btn icon-danger notif-dismiss"
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
                    {/* Sans chiffre : la liste n'est qu'une page (100 au plus), le vidage porte
                        sur tout le centre. Annoncer « les 100 » en effacerait bien davantage. */}
                    Toutes les notifications de votre centre disparaîtront, lues comme non lues.
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
