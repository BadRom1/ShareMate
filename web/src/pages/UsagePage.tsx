import { useCallback, useState } from 'react';
import { api } from '../api';
import type { Equipment, Member, UsageRecord } from '../api';
import { formatDateTime, formatDecimal, meterLabel } from '../format';
import { decimalInputValue, parseDecimal } from '../decimal';
import { errorMessage, useApiResource } from '../useApiResource';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Fab } from '../components/Fab';
import { DecimalInput } from '../components/DecimalInput';

interface Props {
  members: Member[];
  currentMemberId: string;
  /** Équipement de l'espace de travail courant, choisi dans la coque de l'application. */
  equipment: Equipment;
}

/** Valeur du choix « personne pour l'instant » dans les listes d'attribution. */
const EN_ATTENTE = '';

const formVide = {
  startReading: '',
  duration: '',
  meterReading: '',
  fuelAddedLiters: '',
  notes: '',
  isMaintenance: false,
  /** Attribution du relevé corrigé — vide : en attente. */
  memberId: EN_ATTENTE,
  /** Attribution du segment mis au jour par une saisie — vide : en attente. */
  gapMemberId: EN_ATTENTE,
};

/**
 * Compteur au départ d'un relevé. Les relevés antérieurs à ce champ ne le portent pas : leur
 * départ se relit dans la durée que le serveur leur attribue (delta avec le relevé précédent).
 */
function departDe(record: UsageRecord): number | null {
  if (record.startReading !== null) return record.startReading;
  return record.duration === null ? null : Math.round((record.meterReading - record.duration) * 100) / 100;
}

export function UsagePage({ members, currentMemberId, equipment }: Props) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [viewByMember, setViewByMember] = useState(false);
  /** La saisie se fait en modale : l'historique est ce qu'on vient consulter. */
  const [formOpen, setFormOpen] = useState(false);
  /** Relevé en cours de correction ; `null` quand la modale sert à en saisir un nouveau. */
  const [editing, setEditing] = useState<UsageRecord | null>(null);
  const [deleting, setDeleting] = useState<UsageRecord | null>(null);

  const [form, setForm] = useState(formVide);
  /** Champ piloté par l'utilisateur : la durée (le compteur en découle) ou le compteur total. */
  const [entryMode, setEntryMode] = useState<'duration' | 'total'>('duration');

  const historyResource = useApiResource(
    useCallback(async () => {
      const [records, status] = await Promise.all([
        viewByMember ? api.usageByMember(currentMemberId) : api.usageByEquipment(equipment.id),
        api.maintenanceStatus(equipment.id),
      ]);
      // `usageByMember` couvre tous les équipements : l'onglet ne montre que celui de l'espace courant.
      return { records: records.filter((r) => r.equipmentId === equipment.id), status };
    }, [equipment.id, viewByMember, currentMemberId]),
  );

  const history = historyResource.data?.records ?? [];
  const status = historyResource.data?.status ?? null;
  /** Modale ouverte : l'échec de la saisie s'affiche dedans, la page derrière n'est pas lisible. */
  const pageError = formOpen ? historyResource.error : (actionError ?? historyResource.error);

  /** Dernier compteur connu : sert à préremplir le départ et à convertir durée ↔ total. */
  const lastReading = status?.currentReading ?? null;
  const unit = meterLabel(equipment.meterUnit);
  const circle = members.filter((m) => equipment.memberIds.includes(m.id));

  /** Heures constatées que personne n'a encore reconnues — visibles pour être réclamées. */
  const enAttente = history.filter((u) => u.memberId === null);
  /** Un relevé plus haut prouve que l'engin a tourné pendant cet intervalle : ces heures restent. */
  const atteste = (u: UsageRecord) => lastReading !== null && u.meterReading < lastReading;
  const heuresEnAttente = enAttente.reduce((total, u) => total + (u.duration ?? 0), 0);

  /** Bascule l'historique : la confirmation du relevé précédent ne décrit plus ce qui est affiché. */
  function changerVue(parMembre: boolean) {
    setViewByMember(parMembre);
    setInfo(null);
  }

  /** Évite les artefacts de virgule flottante lors des conversions durée ↔ total. */
  const round = (n: number) => Math.round(n * 100) / 100;

  /**
   * Point de départ effectif de la saisie en cours : ce que l'utilisateur a inscrit, à défaut
   * le dernier relevé connu. C'est lui, et non le dernier relevé, qui borne la durée.
   */
  const depart = parseDecimal(form.startReading) ?? (editing ? departDe(editing) : lastReading);
  const saisieCompteur = parseDecimal(form.meterReading);
  const meterBelowStart = saisieCompteur !== null && depart !== null && saisieCompteur < depart;
  /** Écart entre le dernier relevé connu et le compteur trouvé au départ : les heures de personne. */
  const ecart = !editing && depart !== null && lastReading !== null ? round(depart - lastReading) : 0;

  function onDurationChange(value: string) {
    setEntryMode('duration');
    const d = parseDecimal(value);
    setForm((f) => ({
      ...f,
      duration: value,
      meterReading: d !== null && depart !== null ? decimalInputValue(round(depart + d)) : f.meterReading,
    }));
  }

  function onMeterChange(value: string) {
    setEntryMode('total');
    const m = parseDecimal(value);
    // Un compteur sous le point de départ ne donne pas de durée : une durée négative n'a pas de
    // sens, et le champ, qui n'accepte que des nombres positifs, resterait bloqué dessus. Le
    // relevé lui-même est refusé à l'enregistrement.
    const delta = m !== null && depart !== null ? round(m - depart) : null;
    setForm((f) => ({
      ...f,
      meterReading: value,
      duration: delta !== null && delta >= 0 ? decimalInputValue(delta) : '',
    }));
  }

  /**
   * Le départ déplace la durée, pas le compteur d'arrivée : c'est l'arrivée qu'on a sous les yeux,
   * sur le tableau de bord. Une durée devenue impossible (départ passé au-dessus de l'arrivée)
   * s'efface au lieu de rester affichée : la garder, c'est laisser un chiffre faux se faire
   * enregistrer, ou s'accrocher aux frappes suivantes.
   */
  function onStartChange(value: string) {
    const start = parseDecimal(value);
    const m = parseDecimal(form.meterReading);
    const delta = start !== null && m !== null ? round(m - start) : null;
    setForm((f) => ({
      ...f,
      startReading: value,
      duration: delta !== null && delta >= 0 ? decimalInputValue(delta) : '',
    }));
  }

  /** Repart d'une saisie vierge : départ et arrivée prérenseignés au dernier relevé connu. */
  function openForm() {
    setActionError(null);
    setInfo(null);
    setEditing(null);
    const dernier = lastReading !== null ? decimalInputValue(lastReading) : '';
    setForm({ ...formVide, startReading: dernier, meterReading: dernier });
    setEntryMode('duration');
    setFormOpen(true);
  }

  /** Ouvre la correction d'un relevé existant, champs remplis de ce qu'il porte aujourd'hui. */
  function openEdit(record: UsageRecord) {
    setActionError(null);
    setInfo(null);
    setEditing(record);
    const start = departDe(record);
    setForm({
      startReading: start !== null ? decimalInputValue(start) : '',
      duration: start !== null ? decimalInputValue(round(record.meterReading - start)) : '',
      meterReading: decimalInputValue(record.meterReading),
      fuelAddedLiters: record.fuelAddedLiters !== null ? decimalInputValue(record.fuelAddedLiters) : '',
      notes: record.notes ?? '',
      isMaintenance: record.isMaintenance,
      memberId: record.memberId ?? EN_ATTENTE,
      gapMemberId: EN_ATTENTE,
    });
    setEntryMode('total');
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditing(null);
    setActionError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setActionError(null);
    const duration = parseDecimal(form.duration);
    const meterReading = parseDecimal(form.meterReading);
    const startReading = parseDecimal(form.startReading);
    const fuelAddedLiters = parseDecimal(form.fuelAddedLiters);

    if (editing) {
      if (meterReading === null) {
        setActionError('Indiquez le compteur total.');
        return;
      }
      try {
        await api.updateUsage(editing.id, {
          meterReading,
          startReading,
          memberId: form.memberId === EN_ATTENTE ? null : form.memberId,
          fuelAddedLiters,
          notes: form.notes || null,
          isMaintenance: form.isMaintenance,
        });
        closeForm();
        setInfo('Relevé corrigé.');
        await historyResource.reload();
      } catch (e) {
        setActionError(errorMessage(e));
      }
      return;
    }

    const reading =
      entryMode === 'duration' && duration !== null && depart !== null
        ? { duration }
        : meterReading !== null
          ? { meterReading }
          : null;
    if (reading === null) {
      setActionError("Indiquez la durée d'utilisation ou le compteur total.");
      return;
    }
    try {
      const enregistre = await api.recordUsage({
        equipmentId: equipment.id,
        ...reading,
        startReading,
        gapMemberId: form.gapMemberId === EN_ATTENTE ? null : form.gapMemberId,
        fuelAddedLiters,
        notes: form.notes || null,
        isMaintenance: form.isMaintenance,
      });
      setForm(formVide);
      setEntryMode('duration');
      setFormOpen(false);
      setInfo(
        enregistre.gap === null
          ? 'Relevé enregistré.'
          : enregistre.gap.memberId === null
            ? `Relevé enregistré. ${formatDecimal(enregistre.gap.duration ?? 0)} ${unit} restent en attente d'attribution.`
            : `Relevé enregistré. ${formatDecimal(enregistre.gap.duration ?? 0)} ${unit} ont été attribuées à ${memberName(enregistre.gap.memberId)}.`,
      );
      await historyResource.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  /** Reprend à son compte un segment en attente, sans passer par le formulaire. */
  async function claim(record: UsageRecord) {
    setActionError(null);
    try {
      await api.updateUsage(record.id, { memberId: currentMemberId });
      setInfo('Relevé attribué.');
      await historyResource.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setActionError(null);
    try {
      await api.deleteUsage(deleting.id);
      setDeleting(null);
      setInfo('Relevé supprimé.');
      await historyResource.reload();
    } catch (e) {
      setDeleting(null);
      setActionError(errorMessage(e));
    }
  }

  function memberName(id: string | null) {
    if (id === null) return 'En attente';
    return members.find((m) => m.id === id)?.name ?? id;
  }

  return (
    <>
      {pageError && <div className="alert">{pageError}</div>}
      {info && <div className="notice">{info}</div>}

      {status?.alert && (
        <div className="notice">
          🔧 <strong>{equipment.name}</strong> : entretien recommandé —{' '}
          {formatDecimal(status.unitsSinceMaintenance ?? 0)} unités depuis la dernière maintenance (seuil :{' '}
          {formatDecimal(status.threshold ?? 0)}). Déclarez la maintenance via un relevé coché « maintenance effectuée
          ».
        </div>
      )}

      {!viewByMember && heuresEnAttente > 0 && (
        <div className="notice">
          ⏳ {formatDecimal(heuresEnAttente)} {unit} en attente d'attribution : l'engin a tourné sans que personne ne
          saisisse de relevé. Reprenez ces heures ou attribuez-les depuis l'historique.
        </div>
      )}

      <div className="card">
        <div className="row" style={{ alignItems: 'center', marginBottom: '0.5rem' }}>
          <h3 style={{ margin: 0, flex: '0 1 auto' }}>Historique</h3>
          <label className="check" style={{ marginLeft: 'auto', flex: '0 0 auto' }}>
            <input type="checkbox" checked={viewByMember} onChange={(e) => changerVue(e.target.checked)} />
            Mes relevés uniquement
          </label>
        </div>

        {!viewByMember && status && (
          <p>
            {status.alert ? (
              <span className="badge danger">🔧 Entretien requis</span>
            ) : (
              <span className="badge">Entretien à jour</span>
            )}{' '}
            {status.currentReading !== null && (
              <span className="muted">
                Compteur actuel : {formatDecimal(status.currentReading)} {unit}
                {status.threshold !== null &&
                  status.unitsSinceMaintenance !== null &&
                  ` — ${formatDecimal(status.unitsSinceMaintenance)}/${formatDecimal(status.threshold)} depuis la dernière maintenance`}
              </span>
            )}
          </p>
        )}

        {history.length === 0 ? (
          <p className="empty">Aucun relevé.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Membre</th>
                  <th>Durée</th>
                  <th>Compteur</th>
                  <th>Carburant</th>
                  <th>Remarques</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {history.map((u) => (
                  <tr key={u.id}>
                    <td>{formatDateTime(u.recordedAt)}</td>
                    <td>
                      {u.memberId === null ? <span className="badge danger">En attente</span> : memberName(u.memberId)}
                    </td>
                    <td>{u.duration !== null ? `${formatDecimal(u.duration)} ${unit}` : '—'}</td>
                    <td>
                      {departDe(u) !== null && <span className="muted">{formatDecimal(departDe(u) ?? 0)} → </span>}
                      {formatDecimal(u.meterReading)}
                      {u.isMaintenance && (
                        <>
                          {' '}
                          <span className="badge">maintenance</span>
                        </>
                      )}
                    </td>
                    <td>{u.fuelAddedLiters !== null ? `${formatDecimal(u.fuelAddedLiters)} L` : '—'}</td>
                    <td className="muted">{u.notes ?? '—'}</td>
                    <td>
                      <div className="row" style={{ gap: '0.25rem', flexWrap: 'nowrap' }}>
                        {u.memberId === null && (
                          <button className="ghost" onClick={() => void claim(u)}>
                            C'était moi
                          </button>
                        )}
                        <button className="ghost" onClick={() => openEdit(u)}>
                          Modifier
                        </button>
                        {/* Supprimer un segment en attente qu'un relevé plus haut atteste ne
                            peut qu'échouer : ces heures ont tourné, elles s'attribuent. */}
                        {!(u.memberId === null && atteste(u)) && (
                          <button className="danger" onClick={() => setDeleting(u)}>
                            Supprimer
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {formOpen && (
        <Modal title={editing ? 'Corriger un relevé' : "Fin d'utilisation : saisir un relevé"} onClose={closeForm}>
          {actionError && <div className="alert">{actionError}</div>}
          <form className="modal-form" onSubmit={submit}>
            {editing && (
              <label className="field">
                Attribué à
                <select value={form.memberId} onChange={(e) => setForm({ ...form, memberId: e.target.value })}>
                  <option value={EN_ATTENTE}>En attente d'attribution</option>
                  {circle.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="row">
              <label className="field">
                Compteur au départ ({unit})
                <DecimalInput
                  value={form.startReading}
                  onValueChange={onStartChange}
                  placeholder={lastReading === null ? 'Compteur d’origine inconnu' : ''}
                />
                {!editing && lastReading !== null && (
                  <span className={ecart > 0 ? 'field-warn' : 'muted'}>
                    Dernier relevé : {formatDecimal(lastReading)} {unit}
                  </span>
                )}
              </label>
              <label className="field">
                Durée d'utilisation ({unit})
                <DecimalInput
                  value={form.duration}
                  onValueChange={onDurationChange}
                  disabled={depart === null}
                  title={
                    depart === null
                      ? 'Premier relevé : saisissez le compteur total, la durée sera calculée ensuite.'
                      : undefined
                  }
                  placeholder={depart === null ? 'Premier relevé : saisir le compteur' : ''}
                />
              </label>
              <label className="field">
                Compteur total ({unit})
                <DecimalInput value={form.meterReading} onValueChange={onMeterChange} required />
                {depart !== null && meterBelowStart && (
                  <span className="field-warn">
                    Un compteur ne recule pas : le départ est à {formatDecimal(depart)} {unit}.
                  </span>
                )}
              </label>
            </div>

            {ecart > 0 && (
              <div className="notice">
                <p style={{ marginTop: 0 }}>
                  ⏳ {formatDecimal(ecart)} {unit} ont tourné entre le dernier relevé ({formatDecimal(lastReading ?? 0)}{' '}
                  {unit}) et votre départ. Elles ne vous seront pas attribuées.
                </p>
                <label className="field">
                  À qui sont ces {formatDecimal(ecart)} {unit} ?
                  <select value={form.gapMemberId} onChange={(e) => setForm({ ...form, gapMemberId: e.target.value })}>
                    <option value={EN_ATTENTE}>Je ne sais pas — à attribuer plus tard</option>
                    {circle.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            <div className="row">
              <label className="field">
                Carburant ajouté (L, optionnel)
                <DecimalInput
                  value={form.fuelAddedLiters}
                  onValueChange={(value) => setForm({ ...form, fuelAddedLiters: value })}
                />
              </label>
            </div>
            <label className="field">
              Remarques
              <textarea
                rows={2}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="État du matériel, incident, plein fait…"
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.isMaintenance}
                onChange={(e) => setForm({ ...form, isMaintenance: e.target.checked })}
              />
              Maintenance effectuée (vidange, révision…) — remet le compteur d'alerte à zéro
            </label>
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={closeForm}>
                Annuler
              </button>
              <button className="primary">{editing ? 'Enregistrer la correction' : 'Enregistrer le relevé'}</button>
            </div>
          </form>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title="Supprimer ce relevé ?"
          confirmLabel="Supprimer le relevé"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        >
          <p>
            Relevé du {formatDateTime(deleting.recordedAt)}, {formatDecimal(deleting.meterReading)} {unit}
            {deleting.duration !== null && ` (${formatDecimal(deleting.duration)} ${unit})`}.
          </p>
          <p className="muted">
            {atteste(deleting)
              ? 'Un relevé plus haut atteste que l’engin a bien tourné pendant cet intervalle : ses heures restent en attente d’attribution, seules ses remarques et son auteur s’en vont.'
              : 'Dernier relevé de la chaîne : rien au-dessus de lui n’atteste ces heures, il disparaît entièrement et le compteur revient au relevé précédent.'}
          </p>
        </ConfirmDialog>
      )}

      <Fab label="Saisir un relevé" onClick={openForm} />
    </>
  );
}
