import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Equipment, GroupDetail, MaintenanceStatus, UsageRecord } from '../api';
import { formatDateTime, meterLabel } from '../format';

interface Props {
  group: GroupDetail;
  currentMemberId: string;
  /** Équipement à pré-sélectionner (arrivée depuis le calendrier). */
  initialEquipmentId?: string | null;
}

export function UsagePage({ group, currentMemberId, initialEquipmentId }: Props) {
  const [equipments, setEquipments] = useState<Equipment[]>([]);
  const [selectedId, setSelectedId] = useState(initialEquipmentId ?? '');
  const [history, setHistory] = useState<UsageRecord[]>([]);
  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  const [alerts, setAlerts] = useState<MaintenanceStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [viewByMember, setViewByMember] = useState(false);

  const [form, setForm] = useState({ meterReading: '', fuelAddedLiters: '', notes: '', isMaintenance: false });

  const selected = equipments.find((e) => e.id === selectedId) ?? null;

  const loadEquipments = useCallback(async () => {
    const list = await api.listEquipments(group.id);
    setEquipments(list);
    setSelectedId((id) => id || list[0]?.id || '');
    setAlerts(await api.groupAlerts(group.id));
  }, [group.id]);

  const loadHistory = useCallback(async () => {
    if (!selectedId) return;
    if (viewByMember) {
      const records = await api.usageByMember(currentMemberId);
      setHistory(records);
      setStatus(null);
    } else {
      const [records, s] = await Promise.all([api.usageByEquipment(selectedId), api.maintenanceStatus(selectedId)]);
      setHistory(records);
      setStatus(s);
    }
  }, [selectedId, viewByMember, currentMemberId]);

  useEffect(() => {
    loadEquipments().catch((e: Error) => setError(e.message));
  }, [loadEquipments]);

  useEffect(() => {
    loadHistory().catch((e: Error) => setError(e.message));
  }, [loadHistory]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api.recordUsage({
        equipmentId: selectedId,
        memberId: currentMemberId,
        meterReading: Number(form.meterReading),
        fuelAddedLiters: form.fuelAddedLiters === '' ? null : Number(form.fuelAddedLiters),
        notes: form.notes || null,
        isMaintenance: form.isMaintenance,
      });
      setForm({ meterReading: '', fuelAddedLiters: '', notes: '', isMaintenance: false });
      await Promise.all([loadHistory(), loadEquipments()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur.');
    }
  }

  function memberName(id: string) {
    return group.members.find((m) => m.id === id)?.name ?? id;
  }

  function equipmentName(id: string) {
    return equipments.find((e) => e.id === id)?.name ?? id;
  }

  return (
    <>
      {error && <div className="alert">{error}</div>}

      {alerts.map((a) => (
        <div className="notice" key={a.equipmentId}>
          🔧 <strong>{equipmentName(a.equipmentId)}</strong> : entretien recommandé — {a.unitsSinceMaintenance}{' '}
          unités depuis la dernière maintenance (seuil : {a.threshold}). Déclarez la maintenance via un relevé
          coché « maintenance effectuée ».
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
                  Compteur ({selected ? meterLabel(selected.meterUnit) : ''})
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={form.meterReading}
                    onChange={(e) => setForm({ ...form, meterReading: e.target.value })}
                    required
                  />
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
