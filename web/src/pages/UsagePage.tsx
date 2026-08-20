import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Member } from '../api';
import { formatDateTime, meterLabel } from '../format';
import { pickInitialEquipmentId, setLastEquipmentId } from '../lastEquipment';
import { errorMessage, firstError, useApiResource } from '../useApiResource';
import { Modal } from '../components/Modal';
import { IconPlus } from '../components/icons';

interface Props {
  members: Member[];
  currentMemberId: string;
  /** Équipement à pré-sélectionner (arrivée depuis le calendrier). */
  initialEquipmentId?: string | null;
}

export function UsagePage({ members, currentMemberId, initialEquipmentId }: Props) {
  const [selectedId, setSelectedId] = useState(initialEquipmentId ?? '');
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

  const equipmentsResource = useApiResource(
    useCallback(async () => {
      const [list, alerts] = await Promise.all([api.listEquipments(), api.alerts()]);
      setSelectedId((id) =>
        pickInitialEquipmentId(list, currentMemberId, { current: id, deepLink: initialEquipmentId }),
      );
      return { list, alerts };
    }, [currentMemberId, initialEquipmentId]),
  );

  const historyResource = useApiResource(
    useCallback(async () => {
      if (!selectedId) return { records: [], status: null };
      // Le statut est toujours chargé : le formulaire préremplit le total avec le dernier relevé.
      const [records, status] = await Promise.all([
        viewByMember ? api.usageByMember(currentMemberId) : api.usageByEquipment(selectedId),
        api.maintenanceStatus(selectedId),
      ]);
      return { records, status };
    }, [selectedId, viewByMember, currentMemberId]),
  );

  const equipments = equipmentsResource.data?.list ?? [];
  const alerts = equipmentsResource.data?.alerts ?? [];
  const history = historyResource.data?.records ?? [];
  const status = historyResource.data?.status ?? null;
  const loadError = firstError(equipmentsResource, historyResource);
  /** Modale ouverte : l'échec de la saisie s'affiche dedans, la page derrière n'est pas lisible. */
  const pageError = formOpen ? loadError : (actionError ?? loadError);

  const selected = equipments.find((e) => e.id === selectedId) ?? null;
  /** Dernier compteur connu : sert à préremplir le total et à convertir durée ↔ total. */
  const lastReading = status?.currentReading ?? null;

  // Mémorise l'équipement consulté (partagé avec l'onglet Discussions).
  useEffect(() => {
    if (selectedId) setLastEquipmentId(selectedId);
  }, [selectedId]);

  // La confirmation porte sur le relevé qu'on vient d'enregistrer : elle n'a plus lieu
  // d'être dès qu'on regarde un autre historique.
  useEffect(() => {
    setInfo(null);
  }, [selectedId, viewByMember]);

  // Préremplit le total avec le dernier relevé connu (pour la personne suivante).
  useEffect(() => {
    setForm((f) => ({ ...f, duration: '', meterReading: lastReading !== null ? String(lastReading) : '' }));
  }, [selectedId, lastReading]);

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

  /** Équipement affiché avant l'ouverture : « Annuler » ne doit pas laisser l'historique ailleurs. */
  const equipmentBeforeForm = useRef(selectedId);

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
    equipmentBeforeForm.current = selectedId;
    setFormOpen(true);
  }

  /** Abandon : la sélection d'équipement faite dans la modale est défaite avec le reste de la saisie. */
  function closeForm() {
    setFormOpen(false);
    setActionError(null);
    setSelectedId(equipmentBeforeForm.current);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setActionError(null);
    try {
      // En mode durée, on envoie la durée : le serveur l'ajoute au dernier relevé connu,
      // même si quelqu'un d'autre a enregistré un usage entre-temps.
      const reading =
        entryMode === 'duration' && form.duration !== '' && lastReading !== null
          ? { duration: Number(form.duration) }
          : { meterReading: Number(form.meterReading) };
      await api.recordUsage({
        equipmentId: selectedId,
        ...reading,
        fuelAddedLiters: form.fuelAddedLiters === '' ? null : Number(form.fuelAddedLiters),
        notes: form.notes || null,
        isMaintenance: form.isMaintenance,
      });
      setForm({ duration: '', meterReading: '', fuelAddedLiters: '', notes: '', isMaintenance: false });
      setEntryMode('duration');
      setFormOpen(false);
      setInfo('Relevé enregistré.');
      await Promise.all([historyResource.reload(), equipmentsResource.reload()]);
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  function memberName(id: string) {
    return members.find((m) => m.id === id)?.name ?? id;
  }

  function equipmentName(id: string) {
    return equipments.find((e) => e.id === id)?.name ?? id;
  }

  /** Unité du compteur de l'équipement d'une ligne (l'historique par membre mélange les équipements). */
  function unitFor(id: string) {
    return equipments.find((e) => e.id === id)?.meterUnit ?? 'HOURS';
  }

  return (
    <>
      {pageError && <div className="alert">{pageError}</div>}
      {info && <div className="notice">{info}</div>}

      {alerts.map((a) => (
        <div className="notice" key={a.equipmentId}>
          🔧 <strong>{equipmentName(a.equipmentId)}</strong> : entretien recommandé — {a.unitsSinceMaintenance} unités
          depuis la dernière maintenance (seuil : {a.threshold}). Déclarez la maintenance via un relevé coché «
          maintenance effectuée ».
        </div>
      ))}

      {equipments.length === 0 ? (
        <p className="empty">Créez d'abord un équipement.</p>
      ) : (
        <div className="card">
          <div className="row" style={{ alignItems: 'center', marginBottom: '0.5rem' }}>
            <h3 style={{ margin: 0, flex: '0 1 auto' }}>Historique</h3>
            <button type="button" className="primary card-action" onClick={openForm}>
              <IconPlus size={16} /> Saisir un relevé
            </button>
            <select
              style={{ flex: '0 0 auto' }}
              aria-label="Équipement affiché"
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              {equipments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
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
              {status.currentReading !== null && selected && (
                <span className="muted">
                  Compteur actuel : {status.currentReading} {meterLabel(selected.meterUnit)}
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
                    {viewByMember ? <th>Équipement</th> : <th>Membre</th>}
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
                      <td>{viewByMember ? equipmentName(u.equipmentId) : memberName(u.memberId)}</td>
                      <td>{u.duration !== null ? `${u.duration} ${meterLabel(unitFor(u.equipmentId))}` : '—'}</td>
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
      )}

      {formOpen && (
        <Modal title="Fin d'utilisation : saisir un relevé" onClose={closeForm}>
          {actionError && <div className="alert">{actionError}</div>}
          <form className="modal-form" onSubmit={submit}>
            <div className="row">
              <label className="field">
                Équipement
                <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
                  {equipments.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Durée d'utilisation ({selected ? meterLabel(selected.meterUnit) : ''})
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
                Compteur total ({selected ? meterLabel(selected.meterUnit) : ''})
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
                    Dernier relevé : {lastReading} {selected ? meterLabel(selected.meterUnit) : ''}
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
    </>
  );
}
