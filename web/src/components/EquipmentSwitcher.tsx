import { useState } from 'react';
import type { Equipment } from '../api';
import { Modal } from './Modal';
import { IconCheck, IconChevronDown, IconChevronUp, IconGrid, IconPlus } from './icons';

/** Nombre de teintes disponibles pour les pastilles (variables `--eq-1`…`--eq-5` de `:root`). */
const NUANCES = 5;

/**
 * Teinte d'un équipement, dérivée de son identifiant : elle ne bouge pas d'un écran à l'autre,
 * ni d'une session à l'autre, alors que la position dans la liste, elle, bouge.
 */
export function equipmentDotClass(equipmentId: string): string {
  let empreinte = 0;
  for (const caractere of equipmentId) empreinte = (empreinte * 31 + caractere.codePointAt(0)!) % 100003;
  return `eq-dot eq-dot-${(empreinte % NUANCES) + 1}`;
}

/** Pastille de couleur d'un équipement : repère visuel commun au sélecteur et à la vue d'ensemble. */
export function EquipmentDot({ equipmentId }: { equipmentId: string }) {
  return <span className={equipmentDotClass(equipmentId)} aria-hidden="true" />;
}

interface Props {
  equipments: Equipment[];
  currentEquipmentId: string | null;
  onSelectEquipment: (id: string) => void;
  onOpenOverview: () => void;
  onAddEquipment: () => void;
}

/**
 * Sélecteur d'équipement de la barre d'app : l'équipement courant est le titre de l'écran,
 * et le titre lui-même sert de bouton vers les autres.
 *
 * Avec un seul équipement il n'y a rien à sélectionner : la feuille ne propose plus que les
 * deux passages transverses — la vue d'ensemble et l'ajout. Le chevron, lui, reste : il est
 * le seul signe que le titre est un bouton, et sans lui l'utilisateur conclut que ces deux
 * passages ont disparu.
 */
export function EquipmentSwitcher({
  equipments,
  currentEquipmentId,
  onSelectEquipment,
  onOpenOverview,
  onAddEquipment,
}: Props) {
  const [ouvert, setOuvert] = useState(false);
  const courant = equipments.find((e) => e.id === currentEquipmentId) ?? null;
  /** Sous ce seuil, la liste n'apprend rien : elle ne contiendrait que l'équipement déjà affiché. */
  const listeUtile = equipments.length > 1;

  function choisir(action: () => void) {
    setOuvert(false);
    action();
  }

  return (
    <>
      <button
        type="button"
        className="switcher"
        aria-haspopup="dialog"
        aria-expanded={ouvert}
        onClick={() => setOuvert(true)}
      >
        {courant ? <EquipmentDot equipmentId={courant.id} /> : null}
        <span className="switcher-name">{courant ? courant.name : 'Aucun équipement'}</span>
        {ouvert ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
      </button>

      {ouvert && (
        <Modal title={listeUtile ? 'Mes équipements' : 'Navigation'} variant="sheet" onClose={() => setOuvert(false)}>
          <div className="sheet-body">
            {listeUtile && (
              <ul className="sheet-list">
                {equipments.map((equipment) => (
                  <li key={equipment.id}>
                    <button
                      type="button"
                      className="sheet-item"
                      aria-current={equipment.id === currentEquipmentId ? 'true' : undefined}
                      onClick={() => choisir(() => onSelectEquipment(equipment.id))}
                    >
                      <EquipmentDot equipmentId={equipment.id} />
                      <span className="sheet-item-label">{equipment.name}</span>
                      {equipment.id === currentEquipmentId && <IconCheck size={18} />}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <ul className="sheet-list sheet-transverse">
              <li>
                <button type="button" className="sheet-item" onClick={() => choisir(onOpenOverview)}>
                  <IconGrid size={18} />
                  <span className="sheet-item-label">Vue d’ensemble</span>
                </button>
              </li>
              <li>
                <button type="button" className="sheet-item" onClick={() => choisir(onAddEquipment)}>
                  <IconPlus size={18} />
                  <span className="sheet-item-label">Ajouter un équipement</span>
                </button>
              </li>
            </ul>
          </div>
        </Modal>
      )}
    </>
  );
}
