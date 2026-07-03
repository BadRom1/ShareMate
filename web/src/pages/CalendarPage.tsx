import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Equipment, Member, RecurrenceFrequency, Reservation, ReservationStatus } from '../api';
import { formatDay, formatTime, formatDateTime } from '../format';

interface Props {
  members: Member[];
  currentMemberId: string;
  /** Bascule vers l'onglet Usage avec l'équipement pré-sélectionné. */
  onRecordUsage: (equipmentId: string) => void;
}

const STATUS_LABELS: Record<ReservationStatus, string> = {
  PLANNED: 'Prévisionnel',
  REQUIRED: 'Obligatoire',
};

const REPEAT_LABELS: Record<RecurrenceFrequency, string> = {
  WEEKLY: 'Chaque semaine',
  BIWEEKLY: 'Toutes les 2 semaines',
  MONTHLY: 'Chaque mois',
};

/** Couleurs attribuées aux équipements dans le calendrier (cycle). */
const EQUIPMENT_COLORS = ['#1f6f54', '#2b5e8c', '#8c5e2b', '#6d3f8c', '#8c2b4e', '#3d7a7a', '#5e6d1f', '#994f1f'];

/** Plage horaire affichée dans la vue semaine. */
const WEEK_HOUR_START = 6;
const WEEK_HOUR_END = 22;

const DISMISSED_KEY = 'sharemate.usageReminders.dismissed';

/** Priorité en cas de conflit : l'obligatoire prime sur le prévisionnel, sinon le premier créé. */
function hasPriorityOver(a: Reservation, b: Reservation): boolean {
  if (a.status !== b.status) return a.status === 'REQUIRED';
  return a.createdAt < b.createdAt;
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function timeKey(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function startOfWeek(d: Date): Date {
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

/** Premier créneau libre de même durée à partir du créneau demandé. */
function findNextFreeSlot(start: Date, end: Date, others: Reservation[]): { start: Date; end: Date } | null {
  const duration = end.getTime() - start.getTime();
  let candidateStart = start.getTime();
  for (let i = 0; i < 200; i += 1) {
    const candidateEnd = candidateStart + duration;
    const blocking = others.filter((r) => new Date(r.start).getTime() < candidateEnd && candidateStart < new Date(r.end).getTime());
    if (blocking.length === 0) {
      return { start: new Date(candidateStart), end: new Date(candidateEnd) };
    }
    candidateStart = Math.max(...blocking.map((r) => new Date(r.end).getTime()));
  }
  return null;
}

function loadDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

const EMPTY_FORM = {
  equipmentId: '',
  startDate: '',
  startTime: '08:00',
  endDate: '',
  endTime: '18:00',
  status: 'REQUIRED' as ReservationStatus,
  notes: '',
  repeat: '' as '' | RecurrenceFrequency,
  until: '',
};

export function CalendarPage({ members, currentMemberId, onRecordUsage }: Props) {
  const [equipments, setEquipments] = useState<Equipment[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [equipmentFilter, setEquipmentFilter] = useState('all');
  const [view, setView] = useState<'month' | 'week' | 'list'>('month');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string[]>(loadDismissed);
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));

  const [form, setForm] = useState(EMPTY_FORM);

  const load = useCallback(async () => {
    const [eqs, cal] = await Promise.all([api.listEquipments(), api.calendar()]);
    setEquipments(eqs);
    setReservations(cal);
    setForm((f) => (f.equipmentId === '' && eqs.length > 0 ? { ...f, equipmentId: eqs[0].id } : f));
  }, []);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  function memberName(id: string) {
    return members.find((m) => m.id === id)?.name ?? id;
  }

  function equipmentName(id: string) {
    return equipments.find((e) => e.id === id)?.name ?? id;
  }

  function equipmentColor(id: string) {
    const index = equipments.findIndex((e) => e.id === id);
    return EQUIPMENT_COLORS[(index + EQUIPMENT_COLORS.length) % EQUIPMENT_COLORS.length];
  }

  const formStart = form.startDate && form.startTime ? new Date(`${form.startDate}T${form.startTime}`) : null;
  const formEnd = form.endDate && form.endTime ? new Date(`${form.endDate}T${form.endTime}`) : null;

  /** Réservations de l'équipement du formulaire, hors réservation en cours d'édition. */
  const sameEquipment = useMemo(
    () => reservations.filter((r) => r.equipmentId === form.equipmentId && r.id !== editingId),
    [reservations, form.equipmentId, editingId],
  );

  /** Conflits détectés en direct pendant la saisie, avant soumission. */
  const liveConflicts = useMemo(() => {
    if (!formStart || !formEnd || formEnd <= formStart) return [];
    return sameEquipment.filter((r) => new Date(r.start) < formEnd && formStart < new Date(r.end));
  }, [sameEquipment, formStart?.getTime(), formEnd?.getTime()]);

  /** Suggestion : premier créneau libre de même durée après le créneau demandé. */
  const nextFreeSlot = useMemo(() => {
    if (liveConflicts.length === 0 || !formStart || !formEnd) return null;
    return findNextFreeSlot(formStart, formEnd, sameEquipment);
  }, [liveConflicts, sameEquipment, formStart?.getTime(), formEnd?.getTime()]);

  const byId = useMemo(() => new Map(reservations.map((r) => [r.id, r])), [reservations]);

  /** Une réservation en conflit est « prioritaire » si elle prime sur toutes celles qui la chevauchent. */
  const isPriority = useCallback(
    (r: Reservation) =>
      r.conflictIds.every((id) => {
        const other = byId.get(id);
        return !other || hasPriorityOver(r, other);
      }),
    [byId],
  );

  /** Mes réservations à venir sur lesquelles je ne suis pas prioritaire. */
  const myLosingConflicts = useMemo(() => {
    const now = new Date().toISOString();
    return reservations.filter(
      (r) => r.memberId === currentMemberId && r.end > now && r.conflictIds.length > 0 && !isPriority(r),
    );
  }, [reservations, currentMemberId, isPriority]);

  /** Mes créneaux terminés récemment, pour rappeler la saisie du relevé. */
  const usageReminders = useMemo(() => {
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 3600 * 1000;
    return reservations.filter((r) => {
      const end = new Date(r.end).getTime();
      return r.memberId === currentMemberId && end <= now && end > weekAgo && !dismissed.includes(r.id);
    });
  }, [reservations, currentMemberId, dismissed]);

  function dismissReminder(id: string) {
    const next = [...dismissed, id];
    setDismissed(next);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
  }

  function conflictTitle(r: Reservation): string {
    const others = r.conflictIds
      .map((id) => byId.get(id))
      .filter((o): o is Reservation => Boolean(o))
      .map((o) => `${memberName(o.memberId)} (${formatDateTime(o.start)} → ${formatDateTime(o.end)})`);
    return others.length > 0 ? `En conflit avec : ${others.join(', ')}` : '';
  }

  function resetForm() {
    setEditingId(null);
    setForm((f) => ({ ...EMPTY_FORM, equipmentId: f.equipmentId }));
  }

  function startEdit(r: Reservation) {
    const start = new Date(r.start);
    const end = new Date(r.end);
    setEditingId(r.id);
    setInfo(null);
    setError(null);
    setForm({
      equipmentId: r.equipmentId,
      startDate: dateKey(start),
      startTime: timeKey(start),
      endDate: dateKey(end),
      endTime: timeKey(end),
      status: r.status,
      notes: r.notes ?? '',
      repeat: '',
      until: '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function applySlot(slot: { start: Date; end: Date }) {
    setForm((f) => ({
      ...f,
      startDate: dateKey(slot.start),
      startTime: timeKey(slot.start),
      endDate: dateKey(slot.end),
      endTime: timeKey(slot.end),
    }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setInfo(null);
    if (!formStart || !formEnd) return;
    if (formEnd <= formStart) {
      setError('La fin du créneau doit être après le début.');
      return;
    }
    try {
      if (editingId) {
        const updated = await api.updateReservation(editingId, {
          start: formStart.toISOString(),
          end: formEnd.toISOString(),
          status: form.status,
          notes: form.notes || null,
        });
        setInfo(
          updated.conflictIds.length > 0
            ? `Réservation modifiée — attention, elle est en conflit avec ${updated.conflictIds.length} créneau(x).`
            : 'Réservation modifiée.',
        );
        resetForm();
      } else if (form.repeat) {
        if (!form.until) {
          setError('Indiquez la date de fin de répétition.');
          return;
        }
        const created = await api.reserveRecurring({
          equipmentId: form.equipmentId,
          start: formStart.toISOString(),
          end: formEnd.toISOString(),
          status: form.status,
          notes: form.notes || undefined,
          frequency: form.repeat,
          until: form.until,
        });
        const conflicting = created.filter((r) => r.conflictIds.length > 0).length;
        setInfo(
          `${created.length} réservation(s) créée(s) (${REPEAT_LABELS[form.repeat].toLowerCase()})` +
            (conflicting > 0 ? `, dont ${conflicting} en conflit — voir le calendrier.` : '.'),
        );
        resetForm();
      } else {
        const created = await api.reserve({
          equipmentId: form.equipmentId,
          start: formStart.toISOString(),
          end: formEnd.toISOString(),
          status: form.status,
          notes: form.notes || undefined,
        });
        if (created.conflictIds.length > 0) {
          setInfo(
            `Réservation enregistrée avec ${created.conflictIds.length} conflit(s). ` +
              'Les créneaux concernés sont signalés dans le calendrier — voyez ensemble qui est prioritaire.',
          );
        }
        setForm({ ...form, startDate: '', endDate: '', notes: '' });
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur.');
    }
  }

  async function cancel(r: Reservation) {
    if (!confirm('Annuler cette réservation ?')) return;
    await api.cancelReservation(r.id);
    if (editingId === r.id) resetForm();
    await load();
  }

  const visible = useMemo(() => {
    const filtered =
      equipmentFilter === 'all' ? reservations : reservations.filter((r) => r.equipmentId === equipmentFilter);
    return [...filtered].sort((a, b) => a.start.localeCompare(b.start));
  }, [reservations, equipmentFilter]);

  // --- Vue mois ---

  const monthDays = useMemo(() => {
    const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
    const gridStart = startOfWeek(firstDay);
    const lastNeeded = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    const weeksNeeded = Math.ceil((((firstDay.getDay() + 6) % 7) + lastNeeded.getDate()) / 7);
    const days: Date[] = [];
    const d = new Date(gridStart);
    while (days.length < weeksNeeded * 7) {
      days.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
    return days;
  }, [month]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, Reservation[]>();
    for (const r of visible) {
      const start = new Date(r.start);
      const end = new Date(r.end);
      const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      while (cursor < end) {
        const key = dateKey(cursor);
        map.set(key, [...(map.get(key) ?? []), r]);
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    return map;
  }, [visible]);

  function pickDay(d: Date) {
    if (editingId) return;
    const key = dateKey(d);
    setForm((f) => ({ ...f, startDate: key, endDate: f.endDate && f.endDate >= key ? f.endDate : key }));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // --- Vue semaine ---

  const weekDays = useMemo(() => {
    const days: Date[] = [];
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      days.push(d);
    }
    return days;
  }, [weekStart]);

  /** Événements positionnés pour un jour de la vue semaine (top/height en %, colonnes si chevauchement). */
  function weekEventsFor(day: Date) {
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), WEEK_HOUR_START);
    const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), WEEK_HOUR_END);
    const events = visible
      .filter((r) => new Date(r.start) < dayEnd && dayStart < new Date(r.end))
      .sort((a, b) => a.start.localeCompare(b.start));
    const laneEnds: number[] = [];
    const placed = events.map((r) => {
      const start = Math.max(new Date(r.start).getTime(), dayStart.getTime());
      const end = Math.min(new Date(r.end).getTime(), dayEnd.getTime());
      let lane = laneEnds.findIndex((e) => e <= start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(end);
      } else {
        laneEnds[lane] = end;
      }
      const total = dayEnd.getTime() - dayStart.getTime();
      return {
        reservation: r,
        lane,
        top: ((start - dayStart.getTime()) / total) * 100,
        height: Math.max(((end - start) / total) * 100, 4),
      };
    });
    return { placed, laneCount: Math.max(laneEnds.length, 1) };
  }

  const byDay = useMemo(() => {
    const map = new Map<string, Reservation[]>();
    for (const r of visible) {
      const day = dateKey(new Date(r.start));
      map.set(day, [...(map.get(day) ?? []), r]);
    }
    return [...map.entries()];
  }, [visible]);

  const accessibleEquipments = equipments.filter((e) => e.memberIds.includes(currentMemberId));
  const todayKey = dateKey(new Date());
  const monthLabel = month.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const weekLabel = `${weekDays[0].toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} – ${weekDays[6].toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}`;

  function eventTitle(r: Reservation): string {
    return [
      `${equipmentName(r.equipmentId)} — ${memberName(r.memberId)}`,
      `${formatDateTime(r.start)} → ${formatDateTime(r.end)}`,
      STATUS_LABELS[r.status],
      conflictTitle(r),
      r.notes ?? '',
      r.memberId === currentMemberId ? 'Cliquer pour modifier' : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  function eventClick(r: Reservation, e: React.MouseEvent) {
    if (r.memberId !== currentMemberId) return;
    e.stopPropagation();
    startEdit(r);
  }

  return (
    <>
      {error && <div className="alert">{error}</div>}
      {info && <div className="notice">{info}</div>}

      {myLosingConflicts.length > 0 && (
        <div className="alert">
          ⚠️ Vous n'êtes pas prioritaire sur {myLosingConflicts.length} de vos réservations :{' '}
          {myLosingConflicts
            .map((r) => `${equipmentName(r.equipmentId)} le ${formatDateTime(r.start)}`)
            .join(' ; ')}
          . Voyez avec les membres concernés ou déplacez vos créneaux.
        </div>
      )}

      {usageReminders.map((r) => (
        <div className="notice" key={r.id}>
          🔧 Votre créneau <strong>{equipmentName(r.equipmentId)}</strong> ({formatDateTime(r.start)} →{' '}
          {formatDateTime(r.end)}) est terminé. Pensez à saisir le relevé du compteur.{' '}
          <button type="button" className="ghost" onClick={() => onRecordUsage(r.equipmentId)}>
            Saisir le relevé
          </button>{' '}
          <button type="button" className="ghost" onClick={() => dismissReminder(r.id)}>
            Ignorer
          </button>
        </div>
      ))}

      <div className="card">
        <h3>{editingId ? 'Modifier la réservation' : 'Réserver un créneau'}</h3>
        {accessibleEquipments.length === 0 ? (
          <p className="muted">Vous ne faites partie du cercle d'aucun équipement.</p>
        ) : (
          <form className="stack" onSubmit={submit}>
            <div className="row">
              <label className="field">
                Équipement
                <select
                  value={form.equipmentId}
                  disabled={Boolean(editingId)}
                  onChange={(e) => setForm({ ...form, equipmentId: e.target.value })}
                >
                  {(editingId ? equipments : accessibleEquipments).map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Type de réservation
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as ReservationStatus })}
                >
                  <option value="REQUIRED">Obligatoire (besoin ferme)</option>
                  <option value="PLANNED">Prévisionnel (souple)</option>
                </select>
              </label>
            </div>
            <div className="row">
              <label className="field">
                Date de début
                <input
                  type="date"
                  value={form.startDate}
                  onChange={(e) => {
                    const startDate = e.target.value;
                    setForm((f) => ({
                      ...f,
                      startDate,
                      endDate: !f.endDate || f.endDate < startDate ? startDate : f.endDate,
                    }));
                  }}
                  required
                />
              </label>
              <label className="field">
                Heure de début
                <input
                  type="time"
                  value={form.startTime}
                  onChange={(e) => setForm({ ...form, startTime: e.target.value })}
                  required
                />
              </label>
              <label className="field">
                Date de fin
                <input
                  type="date"
                  value={form.endDate}
                  min={form.startDate || undefined}
                  onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                  required
                />
              </label>
              <label className="field">
                Heure de fin
                <input
                  type="time"
                  value={form.endTime}
                  onChange={(e) => setForm({ ...form, endTime: e.target.value })}
                  required
                />
              </label>
            </div>
            {!editingId && (
              <div className="row">
                <label className="field">
                  Répéter
                  <select
                    value={form.repeat}
                    onChange={(e) => setForm({ ...form, repeat: e.target.value as '' | RecurrenceFrequency })}
                  >
                    <option value="">Ne pas répéter</option>
                    <option value="WEEKLY">{REPEAT_LABELS.WEEKLY}</option>
                    <option value="BIWEEKLY">{REPEAT_LABELS.BIWEEKLY}</option>
                    <option value="MONTHLY">{REPEAT_LABELS.MONTHLY}</option>
                  </select>
                </label>
                {form.repeat && (
                  <label className="field">
                    Jusqu'au (inclus)
                    <input
                      type="date"
                      value={form.until}
                      min={form.startDate || undefined}
                      onChange={(e) => setForm({ ...form, until: e.target.value })}
                      required
                    />
                  </label>
                )}
              </div>
            )}
            {liveConflicts.length > 0 && (
              <div className="notice" style={{ marginBottom: 0 }}>
                ⚠️ Ce créneau chevauche {liveConflicts.length} réservation(s) :{' '}
                {liveConflicts
                  .map(
                    (c) =>
                      `${memberName(c.memberId)} (${formatDateTime(c.start)} → ${formatDateTime(c.end)}, ${STATUS_LABELS[c.status].toLowerCase()})`,
                  )
                  .join(' ; ')}
                . Vous pouvez quand même réserver : le conflit sera signalé à tout le monde.
                {nextFreeSlot && (
                  <>
                    {' '}
                    <button type="button" className="ghost" onClick={() => applySlot(nextFreeSlot)}>
                      👉 Décaler au prochain créneau libre : {formatDateTime(nextFreeSlot.start.toISOString())} →{' '}
                      {formatDateTime(nextFreeSlot.end.toISOString())}
                    </button>
                  </>
                )}
              </div>
            )}
            <label className="field">
              Remarque (optionnel)
              <input
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Tranchée jardin, déménagement…"
              />
            </label>
            <div className="row" style={{ alignItems: 'center' }}>
              <button className="primary" style={{ flex: '0 0 auto' }}>
                {editingId ? 'Enregistrer les modifications' : 'Réserver'}
              </button>
              {editingId && (
                <button type="button" className="ghost" style={{ flex: '0 0 auto' }} onClick={resetForm}>
                  Abandonner la modification
                </button>
              )}
            </div>
          </form>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ alignItems: 'center', marginBottom: '0.75rem' }}>
          <h3 style={{ margin: 0, flex: '0 1 auto' }}>Calendrier partagé</h3>
          <div className="view-toggle" style={{ flex: '0 0 auto' }}>
            <button type="button" className={view === 'month' ? 'active' : ''} onClick={() => setView('month')}>
              Mois
            </button>
            <button type="button" className={view === 'week' ? 'active' : ''} onClick={() => setView('week')}>
              Semaine
            </button>
            <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
              Liste
            </button>
          </div>
          <select
            style={{ flex: '0 0 auto', marginLeft: 'auto' }}
            value={equipmentFilter}
            onChange={(e) => setEquipmentFilter(e.target.value)}
          >
            <option value="all">Tous les équipements</option>
            {equipments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>

        {view === 'month' && (
          <>
            <div className="cal-nav">
              <button
                type="button"
                className="ghost"
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
              >
                ‹
              </button>
              <strong style={{ textTransform: 'capitalize' }}>{monthLabel}</strong>
              <button
                type="button"
                className="ghost"
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
              >
                ›
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  const now = new Date();
                  setMonth(new Date(now.getFullYear(), now.getMonth(), 1));
                }}
              >
                Aujourd'hui
              </button>
            </div>
            <div className="cal-grid">
              {['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'].map((d) => (
                <div className="cal-head" key={d}>
                  {d}
                </div>
              ))}
              {monthDays.map((d) => {
                const key = dateKey(d);
                const events = eventsByDay.get(key) ?? [];
                const outside = d.getMonth() !== month.getMonth();
                return (
                  <div
                    key={key}
                    className={`cal-cell${outside ? ' outside' : ''}${key === todayKey ? ' today' : ''}`}
                    onClick={() => pickDay(d)}
                    title="Cliquer pour pré-remplir le formulaire de réservation"
                  >
                    <span className="cal-day-num">{d.getDate()}</span>
                    {events.map((r) => (
                      <div
                        key={r.id}
                        className={`cal-event${r.status === 'PLANNED' ? ' planned' : ''}${r.conflictIds.length > 0 ? ' conflict' : ''}${r.memberId === currentMemberId ? ' mine' : ''}`}
                        style={{ borderLeftColor: equipmentColor(r.equipmentId) }}
                        title={eventTitle(r)}
                        onClick={(e) => eventClick(r, e)}
                      >
                        {r.conflictIds.length > 0 && <span className="conflict-dot" />}
                        <span className="cal-event-time">
                          {dateKey(new Date(r.start)) === key ? formatTime(r.start) : '…'}
                        </span>{' '}
                        {equipmentName(r.equipmentId)} · {memberName(r.memberId)}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>
              Bordure pleine : obligatoire · hachuré : prévisionnel · point rouge : conflit. Cliquez sur un jour pour
              pré-remplir le formulaire, sur une de vos réservations pour la modifier.
            </p>
          </>
        )}

        {view === 'week' && (
          <>
            <div className="cal-nav">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  const d = new Date(weekStart);
                  d.setDate(d.getDate() - 7);
                  setWeekStart(d);
                }}
              >
                ‹
              </button>
              <strong>{weekLabel}</strong>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  const d = new Date(weekStart);
                  d.setDate(d.getDate() + 7);
                  setWeekStart(d);
                }}
              >
                ›
              </button>
              <button type="button" className="ghost" onClick={() => setWeekStart(startOfWeek(new Date()))}>
                Aujourd'hui
              </button>
            </div>
            <div className="week-grid">
              <div className="week-hours-col">
                <div className="week-head" />
                <div className="week-hours">
                  {Array.from({ length: (WEEK_HOUR_END - WEEK_HOUR_START) / 2 }, (_, i) => (
                    <span className="week-hour-label" key={i} style={{ top: `${(i * 2 * 100) / (WEEK_HOUR_END - WEEK_HOUR_START)}%` }}>
                      {WEEK_HOUR_START + i * 2} h
                    </span>
                  ))}
                </div>
              </div>
              {weekDays.map((day) => {
                const { placed, laneCount } = weekEventsFor(day);
                const key = dateKey(day);
                return (
                  <div className="week-day-col" key={key}>
                    <div
                      className={`week-head${key === todayKey ? ' today' : ''}`}
                      onClick={() => pickDay(day)}
                      title="Cliquer pour pré-remplir le formulaire de réservation"
                    >
                      {day.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' })}
                    </div>
                    <div className="week-body" onClick={() => pickDay(day)}>
                      {placed.map(({ reservation: r, lane, top, height }) => (
                        <div
                          key={r.id}
                          className={`week-event${r.status === 'PLANNED' ? ' planned' : ''}${r.conflictIds.length > 0 ? ' conflict' : ''}${r.memberId === currentMemberId ? ' mine' : ''}`}
                          style={{
                            top: `${top}%`,
                            height: `${height}%`,
                            left: `${(lane * 100) / laneCount}%`,
                            width: `${100 / laneCount}%`,
                            borderLeftColor: equipmentColor(r.equipmentId),
                          }}
                          title={eventTitle(r)}
                          onClick={(e) => eventClick(r, e)}
                        >
                          {r.conflictIds.length > 0 && <span className="conflict-dot" />}
                          <span className="cal-event-time">{formatTime(r.start)}</span> {equipmentName(r.equipmentId)}
                          <br />
                          {memberName(r.memberId)}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>
              Plage affichée : {WEEK_HOUR_START} h – {WEEK_HOUR_END} h. Les réservations en conflit s'affichent côte à
              côte. Cliquez sur une de vos réservations pour la modifier.
            </p>
          </>
        )}

        {view === 'list' && (
          <>
            {byDay.length === 0 && <p className="empty">Aucune réservation.</p>}
            {byDay.map(([day, dayReservations]) => (
              <div className="day-group" key={day}>
                <h4>{formatDay(day + 'T12:00:00')}</h4>
                {dayReservations.map((r) => {
                  const multiDay = dateKey(new Date(r.start)) !== dateKey(new Date(r.end));
                  return (
                    <div
                      className={`reservation-item${r.conflictIds.length > 0 ? ' conflict' : ''}`}
                      style={{ borderLeftColor: equipmentColor(r.equipmentId) }}
                      key={r.id}
                    >
                      <span className="time">
                        {formatTime(r.start)} → {multiDay ? formatDateTime(r.end) : formatTime(r.end)}
                      </span>
                      <span className="badge">{equipmentName(r.equipmentId)}</span>
                      <span>{memberName(r.memberId)}</span>
                      {r.status === 'PLANNED' && <span className="badge warn">Prévisionnel</span>}
                      {r.conflictIds.length > 0 && (
                        <span className="badge danger" title={conflictTitle(r)}>
                          Conflit{isPriority(r) ? ' · prioritaire' : ''}
                        </span>
                      )}
                      {r.notes && <span className="muted">{r.notes}</span>}
                      {r.memberId === currentMemberId && (
                        <span style={{ marginLeft: 'auto', display: 'flex', gap: '0.4rem' }}>
                          <button className="ghost" onClick={() => startEdit(r)}>
                            Modifier
                          </button>
                          <button className="danger" onClick={() => void cancel(r)}>
                            Annuler
                          </button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}
