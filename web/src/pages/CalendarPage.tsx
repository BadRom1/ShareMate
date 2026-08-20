import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Equipment, Member, Reservation } from '../api';
import { formatDay, formatTime, formatDateTime } from '../format';
import { errorMessage, useApiResource } from '../useApiResource';
import {
  dateKey,
  hasPriorityOver,
  monthGridDays,
  placeDayEvents,
  reservationsByDay,
  reservationsByStartDay,
  startOfWeek,
  timeKey,
  weekDays,
} from './calendar/grid';
import { EMPTY_DRAFT, REPEAT_LABELS, STATUS_LABELS, ReservationForm, draftRange } from './calendar/ReservationForm';
import { Modal } from '../components/Modal';
import { Fab } from '../components/Fab';

interface Props {
  members: Member[];
  currentMemberId: string;
  /** Équipement de l'espace de travail courant, choisi dans la coque de l'application. */
  equipment: Equipment;
  /** Bascule vers l'onglet Entretien, sur l'équipement du créneau terminé. */
  onRecordUsage: (equipmentId: string) => void;
}

/** Couleurs attribuées aux équipements dans le calendrier (cycle). */
const EQUIPMENT_COLORS = ['#1f6f54', '#2b5e8c', '#8c5e2b', '#6d3f8c', '#8c2b4e', '#3d7a7a', '#5e6d1f', '#994f1f'];

/**
 * Couleur de l'équipement : stable d'une session à l'autre, et distincte d'un espace de travail
 * au suivant, sans dépendre du rang de l'équipement dans une liste qu'on ne charge plus ici.
 */
function equipmentColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % EQUIPMENT_COLORS.length;
  return EQUIPMENT_COLORS[hash];
}

/** Plage horaire affichée dans la vue semaine. */
const WEEK_HOURS = { start: 6, end: 22 };

/**
 * Clé de lecture du code visuel des grilles. La légende visible a disparu, mais l'information
 * reste due : rien d'autre ne dit qu'une bordure hachurée vaut « prévisionnel ». Réservée aux
 * lecteurs d'écran, elle est posée juste avant la grille pour être lue au moment où elle sert.
 */
const GRID_LEGEND =
  'Clé de lecture des créneaux : bordure pleine, créneau obligatoire ; fond hachuré, créneau prévisionnel ; point rouge, créneau en conflit.';

const DISMISSED_KEY = 'sharemate.usageReminders.dismissed';

function loadDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function CalendarPage({ members, currentMemberId, equipment, onRecordUsage }: Props) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [view, setView] = useState<'month' | 'week' | 'list'>('month');
  const [editingId, setEditingId] = useState<string | null>(null);
  /** Le formulaire vit dans une modale : le calendrier reste ce qu'on voit en arrivant. */
  const [formOpen, setFormOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>(loadDismissed);
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));

  // La confirmation porte sur le geste qu'on vient de faire : dès qu'on navigue ailleurs
  // dans la grille, elle ne décrit plus ce qu'on a sous les yeux.
  useEffect(() => {
    setInfo(null);
  }, [view, month, weekStart, equipment.id]);

  const [draft, setDraft] = useState(EMPTY_DRAFT);

  const resource = useApiResource(
    useCallback(async () => {
      // L'agenda du serveur couvre tous les équipements : l'onglet ne montre que celui de
      // l'espace de travail courant.
      const reservations = await api.calendar();
      return reservations.filter((r) => r.equipmentId === equipment.id);
    }, [equipment.id]),
  );

  const reservations = useMemo(() => resource.data ?? [], [resource.data]);
  /** Modale ouverte : l'échec de la saisie s'affiche dedans, la page derrière n'est pas lisible. */
  const pageError = formOpen ? resource.error : (actionError ?? resource.error);
  /** Hors du cercle, l'agenda reste consultable mais aucun créneau n'est réservable. */
  const inCircle = equipment.memberIds.includes(currentMemberId);
  const color = equipmentColor(equipment.id);

  function memberName(id: string) {
    return members.find((m) => m.id === id)?.name ?? id;
  }

  /** Réservations voisines du créneau saisi, hors réservation en cours d'édition. */
  const siblings = useMemo(() => reservations.filter((r) => r.id !== editingId), [reservations, editingId]);

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

  /** Les créneaux qui chevauchent celui-ci, décrits pour l'infobulle. */
  function conflictPeers(r: Reservation): string {
    return r.conflictIds
      .map((id) => byId.get(id))
      .filter((o): o is Reservation => Boolean(o))
      .map((o) => `${memberName(o.memberId)} (${formatDateTime(o.start)} → ${formatDateTime(o.end)})`)
      .join(', ');
  }

  function conflictTitle(r: Reservation): string {
    const peers = conflictPeers(r);
    return peers ? `En conflit avec : ${peers}` : '';
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
    setActionError(null);
    setDraft(EMPTY_DRAFT);
  }

  /** Nouvelle réservation : la saisie repart vierge. */
  function openCreate() {
    setEditingId(null);
    setInfo(null);
    setActionError(null);
    setDraft(EMPTY_DRAFT);
    setFormOpen(true);
  }

  function startEdit(r: Reservation) {
    const start = new Date(r.start);
    const end = new Date(r.end);
    setEditingId(r.id);
    setInfo(null);
    setActionError(null);
    setFormOpen(true);
    setDraft({
      startDate: dateKey(start),
      startTime: timeKey(start),
      endDate: dateKey(end),
      endTime: timeKey(end),
      status: r.status,
      notes: r.notes ?? '',
      repeat: '',
      until: '',
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setActionError(null);
    setInfo(null);
    const range = draftRange(draft);
    if (!range) return;
    if (range.end <= range.start) {
      setActionError('La fin du créneau doit être après le début.');
      return;
    }
    const start = range.start.toISOString();
    const end = range.end.toISOString();
    try {
      if (editingId) {
        const updated = await api.updateReservation(editingId, {
          start,
          end,
          status: draft.status,
          notes: draft.notes || null,
        });
        setInfo(
          updated.conflictIds.length > 0
            ? `Réservation modifiée — attention, elle est en conflit avec ${updated.conflictIds.length} créneau(x).`
            : 'Réservation modifiée.',
        );
        closeForm();
      } else if (draft.repeat) {
        if (!draft.until) {
          setActionError('Indiquez la date de fin de répétition.');
          return;
        }
        const created = await api.reserveRecurring({
          equipmentId: equipment.id,
          start,
          end,
          status: draft.status,
          notes: draft.notes || undefined,
          frequency: draft.repeat,
          until: draft.until,
        });
        const conflicting = created.filter((r) => r.conflictIds.length > 0).length;
        setInfo(
          `${created.length} réservation(s) créée(s) (${REPEAT_LABELS[draft.repeat].toLowerCase()})` +
            (conflicting > 0 ? `, dont ${conflicting} en conflit — voir le calendrier.` : '.'),
        );
        closeForm();
      } else {
        const created = await api.reserve({
          equipmentId: equipment.id,
          start,
          end,
          status: draft.status,
          notes: draft.notes || undefined,
        });
        // La modale se referme : la confirmation s'affiche en tête de page, avec le créneau désormais visible dans la grille.
        setInfo(
          created.conflictIds.length > 0
            ? `Réservation enregistrée avec ${created.conflictIds.length} conflit(s). ` +
                'Les créneaux concernés sont signalés dans le calendrier — voyez ensemble qui est prioritaire.'
            : 'Réservation enregistrée.',
        );
        closeForm();
      }
      await resource.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  async function cancel(r: Reservation) {
    if (!confirm('Annuler cette réservation ?')) return;
    setActionError(null);
    setInfo(null);
    try {
      await api.cancelReservation(r.id);
    } catch (e) {
      // Sans cela, un refus du serveur ne laissait que la ligne inchangée, sans explication.
      setActionError(errorMessage(e));
      return;
    }
    if (editingId === r.id) closeForm();
    await resource.reload();
  }

  const visible = useMemo(() => [...reservations].sort((a, b) => a.start.localeCompare(b.start)), [reservations]);

  const monthDays = useMemo(() => monthGridDays(month), [month]);
  const eventsByDay = useMemo(() => reservationsByDay(visible), [visible]);
  const days = useMemo(() => weekDays(weekStart), [weekStart]);
  const byDay = useMemo(() => reservationsByStartDay(visible), [visible]);

  /** Jour cliqué dans la grille : ouvre la saisie, déjà calée sur ce jour. */
  function pickDay(d: Date) {
    const key = dateKey(d);
    openCreate();
    setDraft((f) => ({ ...f, startDate: key, endDate: key }));
  }

  const todayKey = dateKey(new Date());
  const monthLabel = month.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const weekLabel = `${days[0].toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} – ${days[6].toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}`;

  /**
   * Description d'un créneau, clé de lecture du code visuel comprise : la légende sous la grille
   * a disparu, chaque réservation porte donc elle-même de quoi décoder sa bordure et son point.
   */
  function eventLines(r: Reservation): string[] {
    const peers = conflictPeers(r);
    return [
      `${equipment.name} — ${memberName(r.memberId)}`,
      `${formatDateTime(r.start)} → ${formatDateTime(r.end)}`,
      r.status === 'PLANNED' ? `${STATUS_LABELS.PLANNED} (hachuré)` : `${STATUS_LABELS.REQUIRED} (bordure pleine)`,
      r.conflictIds.length > 0 ? `Point rouge : conflit${peers ? ` avec ${peers}` : ''}` : '',
      r.notes ?? '',
    ].filter(Boolean);
  }

  /** Infobulle : la description, plus l'invite à modifier quand le créneau est le mien. */
  function eventTitle(r: Reservation): string {
    return [...eventLines(r), r.memberId === currentMemberId ? 'Cliquer pour modifier' : ''].filter(Boolean).join('\n');
  }

  /** Même contenu pour les lecteurs d'écran, sur une seule ligne. */
  function eventLabel(r: Reservation): string {
    return eventLines(r).join(' · ');
  }

  function eventClick(r: Reservation, e: React.MouseEvent) {
    // Le clic s'arrête sur la réservation, même quand elle n'est pas modifiable : sinon il
    // atteindrait la cellule du jour, qui ouvrirait une saisie que personne n'a demandée.
    e.stopPropagation();
    if (r.memberId !== currentMemberId) return;
    startEdit(r);
  }

  /*
   * Les grilles se cadrent sur la hauteur visible (voir `.cal-page`) : la carte prend ce qui reste
   * sous les bandeaux. La vue liste garde sa hauteur naturelle, elle n'a rien à étirer.
   */
  const cardClass = view === 'list' ? 'card' : 'card cal-card';

  return (
    <div className="cal-page">
      {pageError && <div className="alert">{pageError}</div>}
      {info && <div className="notice">{info}</div>}

      {myLosingConflicts.length > 0 && (
        <div className="alert">
          ⚠️ Vous n'êtes pas prioritaire sur {myLosingConflicts.length} de vos réservations :{' '}
          {myLosingConflicts.map((r) => `${equipment.name} le ${formatDateTime(r.start)}`).join(' ; ')}. Voyez avec les
          membres concernés ou déplacez vos créneaux.
        </div>
      )}

      {usageReminders.map((r) => (
        <div className="notice" key={r.id}>
          🔧 Votre créneau <strong>{equipment.name}</strong> ({formatDateTime(r.start)} → {formatDateTime(r.end)}) est
          terminé. Pensez à saisir le relevé du compteur.{' '}
          <button type="button" className="ghost" onClick={() => onRecordUsage(r.equipmentId)}>
            Saisir le relevé
          </button>{' '}
          <button type="button" className="ghost" onClick={() => dismissReminder(r.id)}>
            Ignorer
          </button>
        </div>
      ))}

      <div className={cardClass}>
        <div className="view-toggle" role="group" aria-label="Vue du calendrier">
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

        {view === 'month' && (
          <>
            <div className="cal-nav">
              <strong className="cal-period-label month">{monthLabel}</strong>
              <div className="cal-nav-actions">
                <button
                  type="button"
                  className="ghost cal-nav-arrow"
                  aria-label="Mois précédent"
                  onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="ghost cal-nav-arrow"
                  aria-label="Mois suivant"
                  onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
                >
                  ›
                </button>
                <button
                  type="button"
                  className="ghost cal-nav-today"
                  onClick={() => {
                    const now = new Date();
                    setMonth(new Date(now.getFullYear(), now.getMonth(), 1));
                  }}
                >
                  Aujourd'hui
                </button>
              </div>
            </div>
            <p className="visually-hidden">{GRID_LEGEND}</p>
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
                    title="Cliquer pour réserver ce jour"
                  >
                    <span className="cal-day-num">{d.getDate()}</span>
                    {events.map((r) => (
                      <div
                        key={r.id}
                        className={`cal-event${r.status === 'PLANNED' ? ' planned' : ''}${r.conflictIds.length > 0 ? ' conflict' : ''}${r.memberId === currentMemberId ? ' mine' : ''}`}
                        style={{ borderLeftColor: color }}
                        title={eventTitle(r)}
                        aria-label={eventLabel(r)}
                        onClick={(e) => eventClick(r, e)}
                      >
                        {r.conflictIds.length > 0 && <span className="conflict-dot" />}
                        <span className="cal-event-time">
                          {dateKey(new Date(r.start)) === key ? formatTime(r.start) : '…'}
                        </span>{' '}
                        {memberName(r.memberId)}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {view === 'week' && (
          <>
            <div className="cal-nav">
              <strong className="cal-period-label">{weekLabel}</strong>
              <div className="cal-nav-actions">
                <button
                  type="button"
                  className="ghost cal-nav-arrow"
                  aria-label="Semaine précédente"
                  onClick={() => {
                    const d = new Date(weekStart);
                    d.setDate(d.getDate() - 7);
                    setWeekStart(d);
                  }}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="ghost cal-nav-arrow"
                  aria-label="Semaine suivante"
                  onClick={() => {
                    const d = new Date(weekStart);
                    d.setDate(d.getDate() + 7);
                    setWeekStart(d);
                  }}
                >
                  ›
                </button>
                <button
                  type="button"
                  className="ghost cal-nav-today"
                  onClick={() => setWeekStart(startOfWeek(new Date()))}
                >
                  Aujourd'hui
                </button>
              </div>
            </div>
            <p className="visually-hidden">{GRID_LEGEND}</p>
            <div className="week-grid">
              <div className="week-hours-col">
                <div className="week-head" />
                <div className="week-hours">
                  {Array.from({ length: (WEEK_HOURS.end - WEEK_HOURS.start) / 2 }, (_, i) => (
                    <span
                      className="week-hour-label"
                      key={i}
                      style={{ top: `${(i * 2 * 100) / (WEEK_HOURS.end - WEEK_HOURS.start)}%` }}
                    >
                      {WEEK_HOURS.start + i * 2} h
                    </span>
                  ))}
                </div>
              </div>
              {days.map((day) => {
                const { placed, laneCount } = placeDayEvents(day, visible, WEEK_HOURS);
                const key = dateKey(day);
                return (
                  <div className="week-day-col" key={key}>
                    <div
                      className={`week-head${key === todayKey ? ' today' : ''}`}
                      onClick={() => pickDay(day)}
                      title="Cliquer pour réserver ce jour"
                    >
                      <span className="week-head-day">{day.toLocaleDateString('fr-FR', { weekday: 'short' })}</span>
                      <span className="week-head-date">{day.getDate()}</span>
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
                            borderLeftColor: color,
                          }}
                          title={eventTitle(r)}
                          aria-label={eventLabel(r)}
                          onClick={(e) => eventClick(r, e)}
                        >
                          {r.conflictIds.length > 0 && <span className="conflict-dot" />}
                          <span className="cal-event-time">{formatTime(r.start)}</span>
                          <br />
                          {memberName(r.memberId)}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="muted cal-note">
              Plage affichée : {WEEK_HOURS.start} h – {WEEK_HOURS.end} h. Les réservations en conflit s'affichent côte à
              côte.
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
                      style={{ borderLeftColor: color }}
                      key={r.id}
                    >
                      <span className="time">
                        {formatTime(r.start)} → {multiDay ? formatDateTime(r.end) : formatTime(r.end)}
                      </span>
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

      {formOpen && (
        <Modal title={editingId ? 'Modifier la réservation' : 'Réserver un créneau'} onClose={closeForm}>
          {actionError && <div className="alert">{actionError}</div>}
          {!editingId && !inCircle ? (
            <p className="muted">Vous ne faites pas partie du cercle de cet équipement.</p>
          ) : (
            <ReservationForm
              members={members}
              siblings={siblings}
              editing={Boolean(editingId)}
              draft={draft}
              onChange={setDraft}
              onSubmit={submit}
              onCancel={closeForm}
            />
          )}
        </Modal>
      )}

      <Fab label="Réserver un créneau" onClick={openCreate} />
    </div>
  );
}
