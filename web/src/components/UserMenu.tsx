import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Member } from '../api';
import { InstallSteps, useInstallPrompt } from './InstallApp';
import { IconCompass, IconDownload, IconLock, IconLogout, IconMenu, IconUsers } from './icons';

interface Props {
  member: Member;
  /** Administration de l'instance, proposée au seul administrateur. */
  onOpenAdmin: () => void;
  /** Relance de la visite guidée, à la demande — elle ne s'ouvre d'elle-même qu'une fois. */
  onStartTour: () => void;
  /** Déconnexion demandée depuis le menu. */
  onLogout: () => void;
}

type View = 'menu' | 'password' | 'install';

/** Menu hamburger : nom de l'utilisateur connecté, changement de mot de passe et déconnexion. */
export function UserMenu({ member, onOpenAdmin, onStartTour, onLogout }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('menu');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { mode: modeInstallation, installer } = useInstallPrompt();

  // Ferme le menu au clic extérieur.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) setView('menu');
  }

  return (
    <div className="usermenu" ref={panelRef}>
      <button className="usermenu-button" onClick={toggle} aria-label="Menu" aria-expanded={open}>
        <IconMenu size={22} />
        <span className="usermenu-name">{member.name}</span>
      </button>

      {open && (
        <div className="bell-panel usermenu-panel">
          {view === 'menu' && (
            <>
              <div className="usermenu-head">
                <span className="muted">Connecté</span>
                <strong>{member.name}</strong>
              </div>
              <button
                className="menu-item"
                onClick={() => {
                  setOpen(false);
                  onStartTour();
                }}
              >
                <IconCompass size={18} />
                Visite guidée
              </button>
              {/* Rien à installer — déjà sur l'écran d'accueil, ou navigateur qui ne sait pas
                  faire — et l'entrée disparaît : elle ne mènerait nulle part. */}
              {modeInstallation !== null && (
                <button
                  className="menu-item"
                  onClick={() => {
                    if (modeInstallation === 'prompt') {
                      setOpen(false);
                      void installer();
                    } else setView('install');
                  }}
                >
                  <IconDownload size={18} />
                  Installer l&apos;app
                </button>
              )}
              <button className="menu-item" onClick={() => setView('password')}>
                <IconLock size={18} />
                Changer le mot de passe
              </button>
              {/* Un seul compte y a droit, et le serveur le redit : l'entrée ne s'affiche que pour lui. */}
              {member.isAdmin && (
                <button
                  className="menu-item"
                  onClick={() => {
                    setOpen(false);
                    onOpenAdmin();
                  }}
                >
                  <IconUsers size={18} />
                  Administration
                </button>
              )}
              <button className="menu-item menu-item-danger" onClick={onLogout}>
                <IconLogout size={18} />
                Déconnexion
              </button>
            </>
          )}
          {view === 'password' && <ChangePasswordForm onBack={() => setView('menu')} onDone={() => setOpen(false)} />}
          {view === 'install' && <InstallHelp onBack={() => setView('menu')} />}
        </div>
      )}
    </div>
  );
}

/**
 * Étapes d'installation à la main (sous-vue du menu). Safari n'expose aucune API : le menu ne
 * peut pas installer à la place de l'utilisateur, seulement lui dire où se cache le geste.
 */
function InstallHelp({ onBack }: { onBack: () => void }) {
  return (
    <>
      <div className="bell-head">
        <strong>Installer l&apos;app</strong>
        <button className="link" onClick={onBack}>
          ← Retour
        </button>
      </div>
      <InstallSteps />
    </>
  );
}

/** Formulaire de changement de mot de passe (sous-vue du menu). */
function ChangePasswordForm({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirm) {
      setError('Les deux mots de passe ne correspondent pas.');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="bell-head">
        <strong>Changer le mot de passe</strong>
        <button className="link" onClick={onBack}>
          ← Retour
        </button>
      </div>
      {error && <div className="alert">{error}</div>}
      <form className="stack" onSubmit={submit}>
        <label className="field">
          Mot de passe actuel
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoFocus
            required
          />
        </label>
        <label className="field">
          Nouveau mot de passe (8 caractères minimum)
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={8}
            required
          />
        </label>
        <label className="field">
          Confirmer le nouveau mot de passe
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={8} required />
        </label>
        <button className="primary" disabled={busy}>
          Enregistrer
        </button>
      </form>
    </>
  );
}
