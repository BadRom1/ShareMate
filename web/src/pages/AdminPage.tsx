import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { DirectoryMember, MergeCounts } from '../api';
import { errorMessage, useApiResource } from '../useApiResource';
import { ConfirmDialog } from '../components/ConfirmDialog';

/**
 * Administration de l'instance : redonner l'accès à un mot de passe perdu, et réunir deux comptes
 * du même membre.
 *
 * Un doublon naît d'une perte de lien — le dernier équipement qui reliait deux personnes
 * disparaît, elles sortent du champ de vision l'une de l'autre, et l'une recrée l'autre. Cet
 * écran est le seul endroit où l'annuaire n'est pas cadré sur un périmètre : sans cela, les deux
 * comptes à réunir ne s'afficheraient pas ensemble.
 *
 * Qui absorbe qui ne se devine pas : l'ancien compte porte l'historique, le nouveau porte l'accès
 * qui fonctionne. On choisit donc les deux rôles, puis champ par champ le nom et l'email qui
 * survivent — et l'on voit ce qui sera déplacé avant de confirmer, comme pour la suppression d'un
 * équipement, qui annonce ce qu'elle emporte.
 *
 * Le lien de réinitialisation vit ici parce qu'il évite justement d'en arriver là : un mot de
 * passe perdu se redonnait en recréant la personne puis en réunissant les deux comptes — un geste
 * irréversible pour un oubli.
 */

interface Props {
  currentMemberId: string;
}

/** Champ d'identité : de quel compte on retient la valeur. */
type Origine = 'kept' | 'absorbed';

/** Ce que chaque compteur désigne, au singulier et au pluriel. */
const DÉPLACÉ: { clé: keyof MergeCounts; un: string; plusieurs: string }[] = [
  { clé: 'circles', un: 'cercle d’équipement', plusieurs: 'cercles d’équipement' },
  {
    clé: 'circlesMerged',
    un: 'cercle où les deux comptes figuraient : une inscription en double disparaît',
    plusieurs: 'cercles où les deux comptes figuraient : autant d’inscriptions en double disparaissent',
  },
  { clé: 'reservations', un: 'réservation', plusieurs: 'réservations' },
  { clé: 'usageRecords', un: 'relevé d’usage', plusieurs: 'relevés d’usage' },
  { clé: 'expensesPaid', un: 'dépense payée', plusieurs: 'dépenses payées' },
  { clé: 'expenseSplits', un: 'répartition de dépense', plusieurs: 'répartitions de dépense' },
  { clé: 'reimbursements', un: 'remboursement', plusieurs: 'remboursements' },
  {
    clé: 'reimbursementsRemoved',
    un: 'remboursement d’un compte à l’autre, supprimé : il ne pèse rien dans les soldes',
    plusieurs: 'remboursements d’un compte à l’autre, supprimés : ils ne pèsent rien dans les soldes',
  },
  { clé: 'threads', un: 'fil de discussion', plusieurs: 'fils de discussion' },
  { clé: 'messages', un: 'message', plusieurs: 'messages' },
  { clé: 'checklists', un: 'checklist', plusieurs: 'checklists' },
  { clé: 'checklistItems', un: 'point de contrôle coché', plusieurs: 'points de contrôle cochés' },
  { clé: 'documents', un: 'document', plusieurs: 'documents' },
  { clé: 'notifications', un: 'notification', plusieurs: 'notifications' },
  { clé: 'notificationPreferences', un: 'préférence de notification', plusieurs: 'préférences de notification' },
  {
    clé: 'notificationPreferencesDropped',
    un: 'préférence abandonnée : celle du compte conservé l’emporte',
    plusieurs: 'préférences abandonnées : celles du compte conservé l’emportent',
  },
  {
    clé: 'invitedMembers',
    un: 'membre invité par le compte absorbé',
    plusieurs: 'membres invités par le compte absorbé',
  },
  {
    clé: 'pushSubscriptions',
    un: 'abonnement aux notifications push',
    plusieurs: 'abonnements aux notifications push',
  },
  {
    clé: 'sessionsRevoked',
    un: 'session révoquée : l’appareil resté connecté sur ce compte devra se reconnecter',
    plusieurs: 'sessions révoquées : les appareils restés connectés sur ce compte devront se reconnecter',
  },
];

/** Lignes à afficher : ce qui vaut zéro n'apprend rien. */
function lignes(counts: MergeCounts): string[] {
  return DÉPLACÉ.filter((d) => counts[d.clé] > 0).map(
    (d) => `${counts[d.clé]} ${counts[d.clé] > 1 ? d.plusieurs : d.un}`,
  );
}

/** Un compte tel qu'on le reconnaît dans une liste où deux homonymes se ressemblent. */
function étiquette(membre: DirectoryMember): string {
  const marques = [
    membre.isAdmin ? 'administrateur' : null,
    membre.hasPassword ? null : 'jamais connecté',
    membre.email,
  ].filter(Boolean);
  return `${membre.name}${marques.length > 0 ? ` — ${marques.join(', ')}` : ''}`;
}

export function AdminPage({ currentMemberId }: Props) {
  const membersResource = useApiResource(useCallback(() => api.adminMembers(), []));
  const members = membersResource.data;

  const [absorbedId, setAbsorbedId] = useState('');
  const [keptId, setKeptId] = useState('');
  const [nameFrom, setNameFrom] = useState<Origine>('kept');
  const [emailFrom, setEmailFrom] = useState<Origine>('kept');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fait, setFait] = useState<{ name: string; counts: MergeCounts } | null>(null);
  const [cibleReset, setCibleReset] = useState('');
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [émission, setÉmission] = useState(false);
  const [lienRendu, setLienRendu] = useState<{ memberName: string; url: string } | null>(null);

  const absorbed = members?.find((m) => m.id === absorbedId) ?? null;
  const kept = members?.find((m) => m.id === keptId) ?? null;
  const paire = absorbed && kept && absorbed.id !== kept.id ? { absorbed, kept } : null;

  // Identité retenue, champ par champ. Calculée à chaque rendu plutôt que mémoïsée : deux
  // lectures dans un objet de trois champs ne valent pas une dépendance de plus.
  const identité = paire
    ? {
        name: (nameFrom === 'kept' ? paire.kept : paire.absorbed).name,
        email: (emailFrom === 'kept' ? paire.kept : paire.absorbed).email,
      }
    : null;

  /** Couple demandé, sous forme primitive : c'est lui qui identifie l'aperçu affiché. */
  const coupleDemandé = paire ? `${paire.absorbed.id}>${paire.kept.id}` : '';

  // Aperçu chiffré, recalculé à chaque changement de couple : c'est ce qui rend la confirmation
  // autre chose qu'un pari. Il porte le couple qu'il décrit, et n'est lu que si c'est celui qui
  // est à l'écran — deux choix rapprochés afficheraient sinon le décompte du précédent, et un
  // couple invalide garderait celui d'avant.
  const [aperçu, setAperçu] = useState<{ couple: string; counts?: MergeCounts; erreur?: string } | null>(null);
  const àJour = aperçu !== null && aperçu.couple === coupleDemandé;
  const counts = àJour ? (aperçu.counts ?? null) : null;
  const erreurAperçu = àJour ? (aperçu.erreur ?? null) : null;

  useEffect(() => {
    if (coupleDemandé === '') return;
    let courant = true;
    api
      .mergePreview(absorbedId, keptId)
      .then((résultat) => courant && setAperçu({ couple: coupleDemandé, counts: résultat }))
      .catch((e) => courant && setAperçu({ couple: coupleDemandé, erreur: errorMessage(e) }));
    return () => {
      courant = false;
    };
  }, [coupleDemandé, absorbedId, keptId]);

  /**
   * Lien de reprise pour un membre qui a perdu son mot de passe. Le code ne revient qu'une fois,
   * dans cette réponse : il ne vit ensuite que dans cet écran, jusqu'à ce qu'on en émette un
   * autre ou qu'on quitte la page, et se transmet hors application (WhatsApp, SMS…) comme un
   * lien de première connexion.
   */
  async function réinitialiser(membre: DirectoryMember) {
    setError(null);
    // Le lien affiché disparaît avant l'appel, et non après : sur un échec, celui de la personne
    // précédente resterait sinon à l'écran sous la bannière d'erreur, à recopier et à transmettre
    // à la place de celui qu'on croyait venir d'obtenir.
    setLienRendu(null);
    setÉmission(true);
    try {
      const { resetCode } = await api.startPasswordReset(membre.id);
      setLienRendu({ memberName: membre.name, url: `${window.location.origin}/reset/${resetCode}` });
      setCibleReset('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      // Fermée dans tous les cas : l'erreur s'affiche en haut de page, sous la modale.
      setConfirmingReset(false);
      setÉmission(false);
    }
  }

  async function fusionner() {
    if (!paire || !identité) return;
    setBusy(true);
    setError(null);
    try {
      const { counts: déplacés } = await api.mergeMembers({
        absorbedId: paire.absorbed.id,
        keptId: paire.kept.id,
        name: identité.name,
        email: identité.email,
      });
      setFait({ name: identité.name, counts: déplacés });
      setConfirming(false);
      setAbsorbedId('');
      setKeptId('');
      await membersResource.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (members === null) {
    return membersResource.error ? (
      <div className="alert">{membersResource.error}</div>
    ) : (
      <p className="empty">Chargement…</p>
    );
  }

  // L'administrateur peut absorber, jamais être absorbé : l'instance perdrait le seul compte qui
  // autorise le geste, et le rôle ne se redonne qu'avec un script, base en main.
  const absorbables = members.filter((m) => !m.isAdmin);
  const conservables = members.filter((m) => m.id !== absorbedId);
  // Seuls les comptes déjà ouverts : ailleurs, il n'y a pas de mot de passe à remplacer.
  const réinitialisables = members.filter((m) => m.hasPassword);
  const cible = réinitialisables.find((m) => m.id === cibleReset) ?? null;

  return (
    <>
      {(error ?? erreurAperçu) !== null && (
        <div className="alert" onClick={() => setError(null)}>
          {error ?? erreurAperçu}
        </div>
      )}

      {fait && (
        <div className="card">
          <h3>Comptes réunis sous « {fait.name} »</h3>
          {lignes(fait.counts).length === 0 ? (
            <p className="muted">Le compte absorbé ne portait rien : il a simplement disparu.</p>
          ) : (
            <ul className="modal-loss">
              {lignes(fait.counts).map((ligne) => (
                <li key={ligne}>{ligne}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="card">
        <h3>Mot de passe perdu</h3>
        <p className="muted">
          Émettez un lien de réinitialisation pour la personne qui ne peut plus se connecter, et transmettez-le-lui
          (WhatsApp, SMS…). Elle choisit un nouveau mot de passe, et retrouve son compte — ses cercles, ses dépenses et
          ses soldes restent en place, il n’y a rien à recréer ni à réunir. Le lien vaut 24 heures et ne sert qu’une
          fois ; jusqu’à ce qu’il soit utilisé, l’ancien mot de passe continue de fonctionner.
        </p>
        {/* Choisir n'émet rien : sur un select natif au clavier, chaque flèche émet un
            « change », et le lien serait posé pour la personne qu'on ne fait que survoler —
            invalidant au passage celui qu'elle avait déjà reçu. Le geste passe donc par un
            bouton puis une confirmation, comme la fusion plus bas. */}
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setConfirmingReset(true);
          }}
        >
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field">
              Personne à qui redonner l’accès
              <select value={cibleReset} onChange={(e) => setCibleReset(e.target.value)} required>
                <option value="">Choisir…</option>
                {réinitialisables.map((m) => (
                  <option key={m.id} value={m.id}>
                    {étiquette(m)}
                    {m.id === currentMemberId ? ' — vous' : ''}
                  </option>
                ))}
              </select>
            </label>
            <button className="ghost" disabled={cible === null || émission}>
              Émettre le lien…
            </button>
          </div>
        </form>
        {/* Un compte jamais ouvert n'a pas de mot de passe à remplacer : c'est un lien de
            première connexion qu'il lui faut, depuis l'écran des équipements. */}
        <p className="muted">
          Une personne qui n’a jamais choisi de mot de passe n’apparaît pas ici : envoyez-lui un lien de première
          connexion depuis « Mes équipements ».
        </p>
        {lienRendu && (
          <div className="card" style={{ background: 'transparent' }}>
            <p className="muted">
              Transmettez ce lien à <strong>{lienRendu.memberName}</strong> : il ouvre le choix d’un nouveau mot de
              passe, et déconnecte les appareils restés ouverts sur ce compte.
            </p>
            <div className="row">
              <input readOnly value={lienRendu.url} onFocus={(e) => e.target.select()} style={{ flex: 1 }} />
              <button type="button" className="ghost" onClick={() => void navigator.clipboard.writeText(lienRendu.url)}>
                Copier
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Réunir deux comptes</h3>
        <p className="muted">
          Quand la même personne existe deux fois, tout ce que portait le compte absorbé passe au compte conservé —
          cercles, réservations, dépenses, messages — et le compte absorbé disparaît, avec son mot de passe et ses
          sessions. Le geste ne se défait pas.
        </p>

        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setConfirming(true);
          }}
        >
          <div className="row">
            <label className="field">
              Compte absorbé (il disparaît)
              <select value={absorbedId} onChange={(e) => setAbsorbedId(e.target.value)} required>
                <option value="">Choisir…</option>
                {absorbables.map((m) => (
                  <option key={m.id} value={m.id}>
                    {étiquette(m)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Compte conservé (il continue)
              <select value={keptId} onChange={(e) => setKeptId(e.target.value)} required>
                <option value="">Choisir…</option>
                {conservables.map((m) => (
                  <option key={m.id} value={m.id}>
                    {étiquette(m)}
                    {m.id === currentMemberId ? ' — vous' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {paire && (
            <>
              <div>
                <strong>Identité du compte conservé</strong>
                <div className="row" style={{ marginTop: '0.5rem' }}>
                  <label className="field">
                    Nom
                    <select value={nameFrom} onChange={(e) => setNameFrom(e.target.value as Origine)}>
                      <option value="kept">{paire.kept.name} (compte conservé)</option>
                      <option value="absorbed">{paire.absorbed.name} (compte absorbé)</option>
                    </select>
                  </label>
                  <label className="field">
                    Email
                    <select value={emailFrom} onChange={(e) => setEmailFrom(e.target.value as Origine)}>
                      <option value="kept">{paire.kept.email ?? 'aucun'} (compte conservé)</option>
                      <option value="absorbed">{paire.absorbed.email ?? 'aucun'} (compte absorbé)</option>
                    </select>
                  </label>
                </div>
                <p className="muted">
                  L’email sert d’identifiant de connexion : c’est avec celui-là que la personne se connectera.
                </p>
              </div>

              <div>
                <strong>Ce qui sera déplacé</strong>
                {counts === null ? (
                  <p className="empty">Décompte en cours…</p>
                ) : lignes(counts).length === 0 ? (
                  <p className="muted">Le compte absorbé ne porte rien : il disparaîtra simplement.</p>
                ) : (
                  <ul className="modal-loss">
                    {lignes(counts).map((ligne) => (
                      <li key={ligne}>{ligne}</li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          <button className="danger" disabled={!paire || busy}>
            Réunir ces deux comptes…
          </button>
        </form>
      </div>

      <div className="card">
        <h3>Tous les comptes ({members.length})</h3>
        <p className="muted">
          Cette liste ignore les cercles : elle montre aussi les comptes que votre annuaire ne vous montre plus.
        </p>
        <ul className="modal-loss">
          {members.map((m) => (
            <li key={m.id}>{étiquette(m)}</li>
          ))}
        </ul>
      </div>

      {confirmingReset && cible && (
        <ConfirmDialog
          title={`Émettre un lien de reprise pour « ${cible.name} » ?`}
          confirmLabel="Émettre le lien"
          busy={émission}
          onConfirm={() => void réinitialiser(cible)}
          onCancel={() => setConfirmingReset(false)}
        >
          <p style={{ margin: 0 }}>
            Le lien vaut 24 heures et ne sert qu’une fois. Tant qu’il n’est pas utilisé, le mot de passe actuel de
            {` ${cible.name} `}
            continue de fonctionner ; sa consommation le remplace et déconnecte les appareils restés ouverts sur ce
            compte.
          </p>
          <p className="muted" style={{ margin: 0 }}>
            Un lien déjà transmis à cette personne cesse aussitôt de valoir : c’est le nouveau qu’il faudra lui donner.
          </p>
        </ConfirmDialog>
      )}

      {confirming && paire && identité && (
        <ConfirmDialog
          title={`Absorber « ${paire.absorbed.name} » dans « ${paire.kept.name} » ?`}
          confirmLabel="Réunir définitivement"
          busy={busy}
          onConfirm={() => void fusionner()}
          onCancel={() => setConfirming(false)}
        >
          <p style={{ margin: 0 }}>
            Le compte absorbé disparaît, avec son mot de passe et ses sessions : l’appareil qui y est resté connecté
            sera déconnecté. Tout ce qu’il portait passe au compte conservé :
          </p>
          <ul className="modal-loss">
            {(counts ? lignes(counts) : []).map((ligne) => (
              <li key={ligne}>{ligne}</li>
            ))}
          </ul>
          <p className="muted" style={{ margin: 0 }}>
            Le compte conservé continuera sous le nom « {identité.name} »
            {identité.email ? ` et l’adresse ${identité.email}` : ', sans adresse email'}. Rien ne défait ce geste.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
