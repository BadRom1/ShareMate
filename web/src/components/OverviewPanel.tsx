import { useCallback, useMemo } from 'react';
import { api } from '../api';
import type { DirectoryMember, Equipment } from '../api';
import type { Tab } from '../navigation';
import { firstError, useApiResource } from '../useApiResource';
import { useEscape } from '../useEscape';
import { formatDay, formatEuros, formatTime, meterLabel } from '../format';
import { EquipmentDot } from './EquipmentSwitcher';
import { IconClose } from './icons';

/** Horizon de « Ma semaine » : au-delà, une réservation n'appelle plus d'action aujourd'hui. */
const SEMAINE_MS = 7 * 24 * 60 * 60 * 1000;

interface Props {
  equipments: Equipment[];
  members: DirectoryMember[];
  currentMemberId: string;
  onOpenEquipment: (equipmentId: string, tab: Tab) => void;
  onClose: () => void;
}

/**
 * Écran transverse : ce qui attend le membre, tous équipements confondus.
 *
 * Il ne remplace aucun onglet — chaque ligne est un raccourci vers l'écran d'équipement qui
 * porte vraiment l'information. C'est pourquoi il occupe tout l'écran et n'a pas de barre basse :
 * on y entre, on en repart.
 */
export function OverviewPanel({ equipments, members, currentMemberId, onOpenEquipment, onClose }: Props) {
  /** Clé stable des équipements : le tableau, lui, change d'identité à chaque rendu du parent. */
  const ids = equipments.map((e) => e.id).join(',');

  const calendrier = useApiResource(useCallback(() => api.calendar(), []));
  const alertes = useApiResource(useCallback(() => api.alerts(), []));
  const soldes = useApiResource(
    useCallback(async () => {
      const liste = ids === '' ? [] : ids.split(',');
      return Promise.all(liste.map(async (id) => ({ equipmentId: id, balances: await api.balances(id) })));
    }, [ids]),
  );

  const equipementsParId = useMemo(() => new Map(equipments.map((e) => [e.id, e])), [equipments]);
  const moi = members.find((m) => m.id === currentMemberId) ?? null;

  const maSemaine = useMemo(() => {
    const maintenant = Date.now();
    return (calendrier.data ?? [])
      .filter(
        (r) =>
          r.memberId === currentMemberId &&
          new Date(r.end).getTime() >= maintenant &&
          new Date(r.start).getTime() <= maintenant + SEMAINE_MS,
      )
      .sort((a, b) => a.start.localeCompare(b.start));
  }, [calendrier.data, currentMemberId]);

  const aFaire = useMemo(() => (alertes.data ?? []).filter((a) => a.alert), [alertes.data]);

  /**
   * Un solde par équipement, jamais un total : dans ce produit une dette se règle avec les
   * copropriétaires d'un équipement donné, additionner deux équipements ne désignerait personne.
   */
  const mesSoldes = useMemo(
    () =>
      (soldes.data ?? []).map(({ equipmentId, balances }) => ({
        equipmentId,
        montant: balances.find((b) => b.memberId === currentMemberId)?.balanceEuros ?? 0,
      })),
    [soldes.data, currentMemberId],
  );

  useEscape(onClose);

  const erreur = firstError(calendrier, alertes, soldes);
  const nom = (equipmentId: string) => equipementsParId.get(equipmentId)?.name ?? 'Équipement';

  return (
    <section className="overview" aria-label="Vue d’ensemble">
      <div className="overview-inner">
        <header className="overview-head">
          <div className="overview-titles">
            <h2>Vue d’ensemble</h2>
            {moi && <p className="muted">{moi.name}</p>}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="Fermer" aria-label="Fermer">
            <IconClose size={22} />
          </button>
        </header>

        {erreur && <div className="alert">{erreur}</div>}

        <section className="card">
          <h3>Ma semaine</h3>
          {calendrier.loading && calendrier.data === null ? (
            <p className="empty">Chargement…</p>
          ) : maSemaine.length === 0 ? (
            <p className="empty">Aucune réservation cette semaine.</p>
          ) : (
            <ul className="overview-list">
              {maSemaine.map((reservation) => (
                <li key={reservation.id}>
                  <button
                    type="button"
                    className="overview-row"
                    onClick={() => onOpenEquipment(reservation.equipmentId, 'agenda')}
                  >
                    <EquipmentDot equipmentId={reservation.equipmentId} />
                    <span className="overview-row-main">
                      <span className="overview-row-title">
                        {formatDay(reservation.start)} · {formatTime(reservation.start)}
                      </span>
                      <span className="overview-row-sub">{nom(reservation.equipmentId)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h3>À faire</h3>
          {alertes.loading && alertes.data === null ? (
            <p className="empty">Chargement…</p>
          ) : aFaire.length === 0 ? (
            <p className="empty">Aucun entretien en attente.</p>
          ) : (
            <ul className="overview-list">
              {aFaire.map((alerte) => {
                const unite = meterLabel(equipementsParId.get(alerte.equipmentId)?.meterUnit ?? 'HOURS');
                return (
                  <li key={alerte.equipmentId}>
                    <button
                      type="button"
                      className="overview-row"
                      onClick={() => onOpenEquipment(alerte.equipmentId, 'maintenance')}
                    >
                      <EquipmentDot equipmentId={alerte.equipmentId} />
                      <span className="overview-row-main">
                        <span className="overview-row-title">{nom(alerte.equipmentId)}</span>
                        <span className="overview-row-sub">
                          {alerte.unitsSinceMaintenance === null
                            ? 'Entretien à prévoir'
                            : `${alerte.unitsSinceMaintenance} ${unite} depuis le dernier entretien`}
                        </span>
                      </span>
                      <span className="badge warn">Entretien</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card">
          <h3>Mes soldes</h3>
          <p className="muted">Un solde par équipement : ils ne s’additionnent pas.</p>
          {soldes.loading && soldes.data === null ? (
            <p className="empty">Chargement…</p>
          ) : mesSoldes.length === 0 ? (
            <p className="empty">Aucun équipement.</p>
          ) : (
            <ul className="overview-balances">
              {mesSoldes.map(({ equipmentId, montant }) => (
                <li key={equipmentId}>
                  <button
                    type="button"
                    className="overview-balance"
                    onClick={() => onOpenEquipment(equipmentId, 'expenses')}
                  >
                    <span className="overview-balance-head">
                      <EquipmentDot equipmentId={equipmentId} />
                      <span className="overview-row-sub">{nom(equipmentId)}</span>
                    </span>
                    <span className={montant < 0 ? 'amount-neg' : 'amount-pos'}>{formatEuros(montant)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
