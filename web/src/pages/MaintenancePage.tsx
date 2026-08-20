import type { Equipment, Member } from '../api';
import type { MaintenanceSection } from '../navigation';
import { UsagePage } from './UsagePage';
import { ChecklistsPage } from './ChecklistsPage';
import { LotPage } from './LotPage';

/** Les trois faces de la machine : ce qu'on a relevé, ce qu'on a vérifié, ce qui part avec elle. */
const SECTIONS: { id: MaintenanceSection; label: string }[] = [
  { id: 'usage', label: 'Relevés' },
  { id: 'checklists', label: 'Checklists' },
  { id: 'lot', label: 'Contenu du lot' },
];

interface Props {
  members: Member[];
  currentMemberId: string;
  /** Équipement de l'espace de travail courant, choisi dans la coque de l'application. */
  equipment: Equipment;
  section: MaintenanceSection;
  /** La section vit dans l'URL : c'est le parent qui la détient, pas cette page. */
  onSelectSection: (section: MaintenanceSection) => void;
}

/**
 * Machine courante : relevés d'usage, checklists et contenu du lot sous un même onglet.
 * La page ne fait que choisir laquelle des trois vues afficher — chacune garde sa logique.
 */
export function MaintenancePage({ members, currentMemberId, equipment, section, onSelectSection }: Props) {
  return (
    <>
      <div className="segmented" role="tablist">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={section === s.id}
            onClick={() => onSelectSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {section === 'usage' && <UsagePage members={members} currentMemberId={currentMemberId} equipment={equipment} />}
      {section === 'checklists' && (
        <ChecklistsPage members={members} currentMemberId={currentMemberId} equipment={equipment} />
      )}
      {section === 'lot' && <LotPage equipment={equipment} />}
    </>
  );
}
