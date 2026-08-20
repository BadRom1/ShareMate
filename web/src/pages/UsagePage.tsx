import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Equipment, Member } from '../api';
import { formatDateTime, meterLabel } from '../format';
import { errorMessage, useApiResource } from '../useApiResource';
import { Modal } from '../components/Modal';
import { Fab } from '../components/Fab';

interface Props {
  members: Member[];
  currentMemberId: string;
  /** Équipement de l'espace de travail courant, choisi dans la coque de l'application. */
  equipment: Equipment;
}

export function UsagePage({ members, currentMemberId, equipment }: Props) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [viewByMember, setViewByMember] = useState(false);
  /** La saisie se fait en modale : l'historique est ce qu'on vient consulter. */
  const [formOpen, setFormOpen] = useState(false);

  const [form, setForm] = useState({
    duration: '',
    meterReading: '',
    fuelAddedLiters: '',
    notes: '',
    isMaintenance: false,
  });
  /** Champ piloté par l'utilisateur : la durée (le serveur calcule le compteur) ou le compteur total. */
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

  /** Dernier compteur connu : sert à préremplir le total et à convertir durée ↔ total. */
  const lastReading = status?.currentReading ?? null;
  const unit = meterLabel(equipment.meterUnit);

  useEffect(() => {
    setInfo(null);
  }, [equipment.id, viewByMember]);

  useEffect(() => {
    setForm((f) => ({ ...f, duration: '', meterReading: lastReading !== null ? String(lastReading) : '' }));
  }, [equipment.id, lastReading]);

  /** Évite les artefacts de virgule flottante lors des conversions durée ↔ total. */
  const round = (n: number) => Math.round(n * 100) / 100;

  function onDurationChange(value: string) {
    setEntryMode('duration');
    const d = Number(value);
    setForm((f) => ({
      ...f,
      duration: value,
      meterReading:
        value !== '' && Number.isFinite(d) && lastReading !== null ? String(round(lastReading + d)) : f.meterReading,
    }));
  }

  function onMeterChange(value: string) {
    setEntryMode('total');
    const m = Number(value);
    setForm((f) => ({
      ...f,
      meterReading: value,
      duration: value !== '' && Number.isFinite(m) && lastReading !== null ? String(round(m - lastReading)) : '',
    }));
  }

  /** Repart d'une saisie vierge : le compteur total est pré-rempli au dernier relevé connu. */
  function openForm() {
    setActionError(null);
    setInfo(null);
    setForm({
      duration: '',
      meterReading: lastReading !== null ? String(lastReading) : '',
      fuelAddedLiters: '',
      notes: '',
      isMaintenance: false,
    });
    setEntryMode('duration');
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setActionError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setActionError(null);
    try {
      const reading =
        entryMode === 'duration' && form.duration !== '' && lastReading !== null
          ? { duration: Number(form.duration) }
          : { meterReading: Number(form.meterReading) };
      await api.recordUsage({
        equipmentId: equipment.id,
        ...reading,
        fuelAddedLiters: form.fuelAddedLiters === '' ? null : Number(form.fuelAddedLiters),
        notes: form.notes || null,
        isMaintenance: form.isMaintenance,
      });
      setForm({ duration: '', meterReading: '', fuelAddedLiters: '', notes: '', isMaintenance: false });
      setEntryMode('duration');
      setFormOpen(false);
      setInfo('Relevé enregistré.');
      await historyResource.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  function memberName(id: string) {
    return members.find((m) => m.id === id)?.name ?? id;
  }

  return (
    <>
      {pageError && <div className="alert">{pageError}</div>}
      {info && <div className="notice">{info}</div>}

      {status?.alert && (
        <div className="notice">
          🔧 <strong>{equipment.name}</strong> : entretien recommandé — {status.unitsSinceMaintenance} unités depuis la
          dernière maintenance (seuil : {status.threshold}). Déclarez la maintenance via un relevé coché « maintenance
          effectuée ».
        </div>
      )}

      <div className="card">
        <div className="row" style={{ alignItems: 'center', marginBottom: '0.5rem' }}>
          <h3 style={{ margin: 0, flex: '0 1 auto' }}>Historique</h3>
          <label className="check" style={{ marginLeft: 'auto', flex: '0 0 auto' }}>
            <input type="checkbox" checked={viewByMember} onChange={(e) => setViewByMember(e.target.checked)} />
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
                Compteur actuel : {status.currentReading} {unit}
                {status.threshold !== null &&
                  status.unitsSinceMaintenance !== null &&
                  ` — ${status.unitsSinceMaintenance}/${status.threshold} depuis la dernière maintenance`}
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
                </tr>
              </thead>
              <tbody>
                {history.map((u) => (
                  <tr key={u.id}>
                    <td>{formatDateTime(u.recordedAt)}</td>
                    <td>{memberName(u.memberId)}</td>
                    <td>{u.duration !== null ? `${u.duration} ${unit}` : '—'}</td>
                    <td>
                      {u.meterReading}
                      {u.isMaintenance && (
                        <>
                          {' '}
                          <span className="badge">maintenance</span>
                        </>
                      )}
                    </td>
                    <td>{u.fuelAddedLiters !== null ? `${u.fuelAddedLiters} L` : '—'}</td>
                    <td className="muted">{u.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {formOpen && (
        <Modal title="Fin d'utilisation : saisir un relevé" onClose={closeForm}>
          {actionError && <div className="alert">{actionError}</div>}
          <form className="modal-form" onSubmit={submit}>
            <div className="row">
              <label className="field">
                Durée d'utilisation ({unit})
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={form.duration}
                  onChange={(e) => onDurationChange(e.target.value)}
                  disabled={lastReading === null}
                  title={
                    lastReading === null
                      ? 'Premier relevé : saisissez le compteur total, la durée sera calculée ensuite.'
                      : undefined
                  }
                  placeholder={lastReading === null ? 'Premier relevé : saisir le compteur' : ''}
                />
              </label>
              <label className="field">
                Compteur total ({unit})
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={form.meterReading}
                  onChange={(e) => onMeterChange(e.target.value)}
                  required
                />
                {lastReading !== null && (
                  <span className="muted">
                    Dernier relevé : {lastReading} {unit}
                  </span>
                )}
              </label>
              <label className="field">
                Carburant ajouté (L, optionnel)
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={form.fuelAddedLiters}
                  onChange={(e) => setForm({ ...form, fuelAddedLiters: e.target.value })}
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
              <button className="primary">Enregistrer le relevé</button>
            </div>
          </form>
        </Modal>
      )}

      <Fab label="Saisir un relevé" onClick={openForm} />
    </>
  );
}
