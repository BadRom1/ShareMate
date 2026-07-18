import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Member } from '../api';
import { IconLock, IconLogout, IconMenu } from './icons';

interface Props {
  member: Member;
  /** Déconnexion demandée depuis le menu. */
  onLogout: () => void;
}

type View = 'menu' | 'password';

/** Menu hamburger : nom de l'utilisateur connecté, changement de mot de passe et déconnexion. */
export function UserMenu({ member, onLogout }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('menu');
  const panelRef = useRef<HTMLDivElement | null>(null);

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
          {view === 'menu' ? (
            <>
              <div className="usermenu-head">
                <span className="muted">Connecté</span>
                <strong>{member.name}</strong>
              </div>
              <button className="menu-item" onClick={() => setView('password')}>
                <IconLock size={18} />
                Changer le mot de passe
              </button>
              <button className="menu-item menu-item-danger" onClick={onLogout}>
                <IconLogout size={18} />
                Déconnexion
              </button>
            </>
          ) : (
            <ChangePasswordForm onBack={() => setView('menu')} onDone={() => setOpen(false)} />
          )}
        </div>
      )}
    </div>
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
