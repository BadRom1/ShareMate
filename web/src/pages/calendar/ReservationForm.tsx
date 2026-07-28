import { useMemo } from 'react';
import type { Equipment, Member, RecurrenceFrequency, Reservation, ReservationStatus } from '../../api';
import { formatDateTime } from '../../format';
import { dateKey, findNextFreeSlot, overlapping, timeKey } from './grid';

export const STATUS_LABELS: Record<ReservationStatus, string> = {
  PLANNED: 'Prévisionnel',
  REQUIRED: 'Obligatoire',
};

export const REPEAT_LABELS: Record<RecurrenceFrequency, string> = {
  WEEKLY: 'Chaque semaine',
  BIWEEKLY: 'Toutes les 2 semaines',
  MONTHLY: 'Chaque mois',
};

/** Saisie du formulaire : dates et heures séparées, comme les champs HTML. */
export interface ReservationDraft {
  equipmentId: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  status: ReservationStatus;
  notes: string;
  repeat: '' | RecurrenceFrequency;
  until: string;
}

export const EMPTY_DRAFT: ReservationDraft = {
  equipmentId: '',
  startDate: '',
  startTime: '08:00',
  endDate: '',
  endTime: '18:00',
  status: 'REQUIRED',
  notes: '',
  repeat: '',
  until: '',
};

/** Créneau saisi, ou `null` tant que les dates ne sont pas renseignées. */
export function draftRange(draft: ReservationDraft): { start: Date; end: Date } | null {
  if (!draft.startDate || !draft.startTime || !draft.endDate || !draft.endTime) return null;
  return {
    start: new Date(`${draft.startDate}T${draft.startTime}`),
    end: new Date(`${draft.endDate}T${draft.endTime}`),
  };
}

/** Recale la saisie sur un créneau donné (jour cliqué dans la grille, créneau suggéré). */
export function draftForSlot(draft: ReservationDraft, slot: { start: Date; end: Date }): ReservationDraft {
  return {
    ...draft,
    startDate: dateKey(slot.start),
    startTime: timeKey(slot.start),
    endDate: dateKey(slot.end),
    endTime: timeKey(slot.end),
  };
}

interface Props {
  /** Équipements proposés : ceux du cercle du membre, ou tous en modification. */
  equipments: Equipment[];
  members: Member[];
  /** Réservations du même équipement, pour signaler les chevauchements pendant la saisie. */
  siblings: Reservation[];
  editing: boolean;
  draft: ReservationDraft;
  onChange: (update: (draft: ReservationDraft) => ReservationDraft) => void;
  onSubmit: (event: React.FormEvent) => void;
  onCancelEdit: () => void;
}

/** Formulaire de réservation (création, répétition et modification d'un créneau). */
export function ReservationForm({
  equipments,
  members,
  siblings,
  editing,
  draft,
  onChange,
  onSubmit,
  onCancelEdit,
}: Props) {
  const range = useMemo(() => draftRange(draft), [draft]);

  /** Conflits détectés en direct pendant la saisie, avant soumission. */
  const conflicts = useMemo(() => {
    if (!range || range.end <= range.start) return [];
    return overlapping(range.start, range.end, siblings);
  }, [range, siblings]);

  /** Suggestion : premier créneau libre de même durée après le créneau demandé. */
  const nextFreeSlot = useMemo(() => {
    if (conflicts.length === 0 || !range) return null;
    return findNextFreeSlot(range.start, range.end, siblings);
  }, [conflicts, range, siblings]);

  function memberName(id: string) {
    return members.find((m) => m.id === id)?.name ?? id;
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="row">
        <label className="field">
          Équipement
          <select
            value={draft.equipmentId}
            disabled={editing}
            onChange={(e) => onChange((d) => ({ ...d, equipmentId: e.target.value }))}
          >
            {equipments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Type de réservation
          <select
            value={draft.status}
            onChange={(e) => onChange((d) => ({ ...d, status: e.target.value as ReservationStatus }))}
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
            value={draft.startDate}
            onChange={(e) => {
              const startDate = e.target.value;
              // La fin suit le début tant qu'elle le précède : sinon le créneau serait invalide.
              onChange((d) => ({
                ...d,
                startDate,
                endDate: !d.endDate || d.endDate < startDate ? startDate : d.endDate,
              }));
            }}
            required
          />
        </label>
        <label className="field">
          Heure de début
          <input
            type="time"
            value={draft.startTime}
            onChange={(e) => onChange((d) => ({ ...d, startTime: e.target.value }))}
            required
          />
        </label>
        <label className="field">
          Date de fin
          <input
            type="date"
            value={draft.endDate}
            min={draft.startDate || undefined}
            onChange={(e) => onChange((d) => ({ ...d, endDate: e.target.value }))}
            required
          />
        </label>
        <label className="field">
          Heure de fin
          <input
            type="time"
            value={draft.endTime}
            onChange={(e) => onChange((d) => ({ ...d, endTime: e.target.value }))}
            required
          />
        </label>
      </div>
      {!editing && (
        <div className="row">
          <label className="field">
            Répéter
            <select
              value={draft.repeat}
              onChange={(e) => onChange((d) => ({ ...d, repeat: e.target.value as '' | RecurrenceFrequency }))}
            >
              <option value="">Ne pas répéter</option>
              <option value="WEEKLY">{REPEAT_LABELS.WEEKLY}</option>
              <option value="BIWEEKLY">{REPEAT_LABELS.BIWEEKLY}</option>
              <option value="MONTHLY">{REPEAT_LABELS.MONTHLY}</option>
            </select>
          </label>
          {draft.repeat && (
            <label className="field">
              Jusqu'au (inclus)
              <input
                type="date"
                value={draft.until}
                min={draft.startDate || undefined}
                onChange={(e) => onChange((d) => ({ ...d, until: e.target.value }))}
                required
              />
            </label>
          )}
        </div>
      )}
      {conflicts.length > 0 && (
        <div className="notice" style={{ marginBottom: 0 }}>
          ⚠️ Ce créneau chevauche {conflicts.length} réservation(s) :{' '}
          {conflicts
            .map(
              (c) =>
                `${memberName(c.memberId)} (${formatDateTime(c.start)} → ${formatDateTime(c.end)}, ${STATUS_LABELS[c.status].toLowerCase()})`,
            )
            .join(' ; ')}
          . Vous pouvez quand même réserver : le conflit sera signalé à tout le monde.
          {nextFreeSlot && (
            <>
              {' '}
              <button type="button" className="ghost" onClick={() => onChange((d) => draftForSlot(d, nextFreeSlot))}>
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
          value={draft.notes}
          onChange={(e) => onChange((d) => ({ ...d, notes: e.target.value }))}
          placeholder="Tranchée jardin, déménagement…"
        />
      </label>
      <div className="row" style={{ alignItems: 'center' }}>
        <button className="primary" style={{ flex: '0 0 auto' }}>
          {editing ? 'Enregistrer les modifications' : 'Réserver'}
        </button>
        {editing && (
          <button type="button" className="ghost" style={{ flex: '0 0 auto' }} onClick={onCancelEdit}>
            Abandonner la modification
          </button>
        )}
      </div>
    </form>
  );
}
