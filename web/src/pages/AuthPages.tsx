import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Member } from '../api';

/** Écrans publics : connexion, création du premier compte, invitation. */

export function LoginPage({ onLoggedIn }: { onLoggedIn: (member: Member) => void }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { member } = await api.login(identifier, password);
      onLoggedIn(member);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: '3rem', maxWidth: '26rem', marginInline: 'auto' }}>
      <h2>🚜 ShareMate</h2>
      <p className="muted">Connectez-vous pour accéder aux équipements partagés.</p>
      {error && <div className="alert">{error}</div>}
      <form className="stack" onSubmit={submit}>
        <label className="field">
          Nom ou email
          <input value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoFocus required />
        </label>
        <label className="field">
          Mot de passe
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button className="primary" disabled={busy}>
          Se connecter
        </button>
        <p className="muted">
          Pas encore de mot de passe ? Demandez un lien d'invitation à un membre de votre cercle.
        </p>
      </form>
    </div>
  );
}

export function BootstrapPage({ onCreated }: { onCreated: (member: Member) => void }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { member } = await api.bootstrap({ name, password });
      onCreated(member);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: '3rem', maxWidth: '30rem', marginInline: 'auto' }}>
      <h2>🚜 Bienvenue sur ShareMate</h2>
      <p className="muted">
        Ici, ce sont les objets qui portent leurs utilisateurs : chaque équipement a son propre cercle de
        partage (réservations, suivi d'usage, frais). Créez d'abord votre compte ; vous inviterez ensuite les
        personnes avec qui vous partagez, depuis l'onglet Équipements.
      </p>
      {error && <div className="alert">{error}</div>}
      <form className="stack" onSubmit={submit}>
        <label className="field">
          Votre prénom
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </label>
        <label className="field">
          Mot de passe (8 caractères minimum)
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
        </label>
        <button className="primary" disabled={busy}>
          C'est parti
        </button>
      </form>
    </div>
  );
}

export function InvitePage({ code, onRedeemed }: { code: string; onRedeemed: (member: Member) => void }) {
  const [memberName, setMemberName] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .inviteInfo(code)
      .then((info) => setMemberName(info.memberName))
      .catch((err: Error) => setError(err.message));
  }, [code]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { member } = await api.redeemInvite(code, password);
      onRedeemed(member);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: '3rem', maxWidth: '26rem', marginInline: 'auto' }}>
      <h2>🚜 ShareMate</h2>
      {error && <div className="alert">{error}</div>}
      {memberName === null && !error && <p className="empty">Vérification de l'invitation…</p>}
      {memberName !== null && (
        <>
          <p className="muted">
            Bonjour <strong>{memberName}</strong> ! Choisissez votre mot de passe pour activer votre accès.
          </p>
          <form className="stack" onSubmit={submit}>
            <label className="field">
              Mot de passe (8 caractères minimum)
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                autoFocus
                required
              />
            </label>
            <button className="primary" disabled={busy}>
              Activer mon accès
            </button>
          </form>
        </>
      )}
    </div>
  );
}
