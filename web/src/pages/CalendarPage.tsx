import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Equipment, GroupDetail, Reservation } from '../api';
import { formatDay, formatTime } from '../format';

interface Props {
  group: GroupDetail;
  currentMemberId: string;
}

export function CalendarPage({ group, currentMemberId }: Props) {
  const [equipments, setEquipments] = useState<Equipment[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [equipmentFilter, setEquipmentFilter] = useState('all');

  const [form, setForm] = useState({
    equipmentId: '',
    start: '',
    end: '',
    notes: '',
  });

  const load = useCallback(async () => {
    const [eqs, cal] = await Promise.all([api.listEquipments(group.id), api.groupCalendar(group.id)]);
    setEquipments(eqs);
    setReservations(cal);
    setForm((f) => (f.equipmentId === '' && eqs.length > 0 ? { ...f, equipmentId: eqs[0].id } : f));
  }, [group.id]);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api.reserve({
        equipmentId: form.equipmentId,
        memberId: currentMemberId,
        start: new Date(form.start).toISOString(),
        end: new Date(form.end).toISOString(),
        notes: form.notes || undefined,
      });
      setForm({ ...form, start: '', end: '', notes: '' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur.');
    }
  }

  async function cancel(r: Reservation) {
    if (!confirm('Annuler cette réservation ?')) return;
    await api.cancelReservation(r.id);
    await load();
  }

  function memberName(id: string) {
    return group.members.find((m) => m.id === id)?.name ?? id;
  }

  function equipmentName(id: string) {
    return equipments.find((e) => e.id === id)?.name ?? id;
  }

  const visible = useMemo(() => {
    const filtered =
      equipmentFilter === 'all' ? reservations : reservations.filter((r) => r.equipmentId === equipmentFilter);
    return [...filtered].sort((a, b) => a.start.localeCompare(b.start));
  }, [reservations, equipmentFilter]);

  const byDay = useMemo(() => {
    const map = new Map<string, Reservation[]>();
    for (const r of visible) {
      const day = r.start.slice(0, 10);
      map.set(day, [...(map.get(day) ?? []), r]);
    }
    return [...map.entries()];
  }, [visible]);

  const accessibleEquipments = equipments.filter((e) => e.accessMemberIds.includes(currentMemberId));

  return (
    <>
      {error && <div className="alert">{error}</div>}

      <div className="card">
        <h3>Réserver un créneau</h3>
        {accessibleEquipments.length === 0 ? (
          <p className="muted">Aucun équipement accessible pour vous.</p>
        ) : (
          <form className="stack" onSubmit={submit}>
            <div className="row">
              <label className="field">
                Équipement
                <select value={form.equipmentId} onChange={(e) => setForm({ ...form, equipmentId: e.target.value })}>
                  {accessibleEquipments.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Début
                <input
                  type="datetime-local"
                  value={form.start}
                  onChange={(e) => setForm({ ...form, start: e.target.value })}
                  required
                />
              </label>
              <label className="field">
                Fin
                <input
                  type="datetime-local"
                  value={form.end}
                  onChange={(e) => setForm({ ...form, end: e.target.value })}
                  required
                />
              </label>
            </div>
            <label className="field">
              Remarque (optionnel)
              <input
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Tranchée jardin, déménagement…"
              />
            </label>
            <button className="primary">Réserver</button>
          </form>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ alignItems: 'center', marginBottom: '0.5rem' }}>
          <h3 style={{ margin: 0 }}>Calendrier du groupe</h3>
          <select value={equipmentFilter} onChange={(e) => setEquipmentFilter(e.target.value)}>
            <option value="all">Tous les équipements</option>
            {equipments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>

        {byDay.length === 0 && <p className="empty">Aucune réservation.</p>}

        {byDay.map(([day, dayReservations]) => (
          <div className="day-group" key={day}>
            <h4>{formatDay(day + 'T12:00:00')}</h4>
            {dayReservations.map((r) => (
              <div className="reservation-item" key={r.id}>
                <span className="time">
                  {formatTime(r.start)} → {formatTime(r.end)}
                </span>
                <span className="badge">{equipmentName(r.equipmentId)}</span>
                <span>{memberName(r.memberId)}</span>
                {r.notes && <span className="muted">{r.notes}</span>}
                {r.memberId === currentMemberId && (
                  <button className="danger" style={{ marginLeft: 'auto' }} onClick={() => void cancel(r)}>
                    Annuler
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
