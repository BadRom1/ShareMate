import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Equipment, MaintenanceStatus, Member, UsageRecord } from '../api';
import { formatDateTime, meterLabel } from '../format';

interface Props {
  members: Member[];
  currentMemberId: string;
  /** Équipement à pré-sélectionner (arrivée depuis le calendrier). */
  initialEquipmentId?: string | null;
}

export function UsagePage({ members, currentMemberId, initialEquipmentId }: Props) {
  const [equipments, setEquipments] = useState<Equipment[]>([]);
  const [selectedId, setSelectedId] = useState(initialEquipmentId ?? '');
  const [history, setHistory] = useState<UsageRecord[]>([]);
  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  const [alerts, setAlerts] = useState<MaintenanceStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [viewByMember, setViewByMember] = useState(false);

  const [form, setForm] = useState({
    duration: '',
    meterReading: '',
    fuelAddedLiters: '',
    notes: '',
    isMaintenance: false,
  });
  /** Champ piloté par l'utilisateur : la durée (le serveur calcule le compteur) ou le compteur total. */
  const [entryMode, setEntryMode] = useState<'duration' | 'total'>('duration');

  const selected = equipments.find((e) => e.id === selectedId) ?? null;
  /** Dernier compteur connu : sert à préremplir le total et à convertir durée ↔ total. */
  const lastReading = status?.currentReading ?? null;

  const loadEquipments = useCallback(async () => {
    const list = await api.listEquipments();
    setEquipments(list);
    setSelectedId((id) => id || list[0]?.id || '');
    setAlerts(await api.alerts());
  }, []);

  const loadHistory = useCallback(async () => {
    if (!selectedId) return;
    // Le statut est toujours chargé : le formulaire préremplit le total avec le dernier relevé.
    const [records, s] = await Promise.all([
      viewByMember ? api.usageByMember(currentMemberId) : api.usageByEquipment(selectedId),
      api.maintenanceStatus(selectedId),
    ]);
    setHistory(records);
    setStatus(s);
  }, [selectedId, viewByMember, currentMemberId]);

  useEffect(() => {
    loadEquipments().catch((e: Error) => setError(e.message));
  }, [loadEquipments]);

  useEffect(() => {
    loadHistory().catch((e: Error) => setError(e.message));
  }, [loadHistory]);

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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
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
      await Promise.all([loadHistory(), loadEquipments()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur.');
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
      {error && <div className="alert">{error}</div>}

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
        <>
          <div className="card">
            <h3>Fin d'utilisation : saisir un relevé</h3>
            <form className="stack" onSubmit={submit}>
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
              <button className="primary">Enregistrer le relevé</button>
            </form>
          </div>

          <div className="card">
            <div className="row" style={{ alignItems: 'center', marginBottom: '0.5rem' }}>
              <h3 style={{ margin: 0 }}>Historique</h3>
              <label className="check" style={{ marginLeft: 'auto' }}>
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
        </>
      )}
    </>
  );
}
