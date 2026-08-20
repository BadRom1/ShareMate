import type { ComponentType, ReactNode } from 'react';
import type { Equipment, Member } from '../api';
import type { Tab } from '../navigation';
import { TABS } from '../navigation';
import { EquipmentSwitcher } from './EquipmentSwitcher';
import { NotificationBell } from './NotificationBell';
import { UserMenu } from './UserMenu';
import { IconCalendar, IconChat, IconEuro, IconFolder, IconWrench } from './icons';

/** Icône de chaque section : la barre basse se lit d'un coup d'œil, avant même le libellé. */
const TAB_ICONS: Record<Tab, ComponentType<{ size?: number }>> = {
  agenda: IconCalendar,
  maintenance: IconWrench,
  expenses: IconEuro,
  forum: IconChat,
  documents: IconFolder,
};

interface Props {
  equipments: Equipment[];
  currentEquipmentId: string | null;
  tab: Tab;
  member: Member;
  onSelectEquipment: (id: string) => void;
  onSelectTab: (tab: Tab) => void;
  onOpenOverview: () => void;
  onAddEquipment: () => void;
  /** Navigation demandée par un lien de notification, passée telle quelle à la cloche. */
  onNavigate: (link: string) => void;
  onLogout: () => void;
  children: ReactNode;
}

/**
 * Coque de l'application : l'équipement courant en haut, ses sections en bas, son contenu entre les deux.
 *
 * Le modèle est celui d'un espace de travail — on choisit d'abord de quel équipement on parle,
 * et tout l'écran parle de celui-là. La coque tient la hauteur visible et ne défile pas : seul
 * le contenu défile, entre les deux barres. La barre basse est donc toujours sous le pouce.
 */
export function AppShell({
  equipments,
  currentEquipmentId,
  tab,
  member,
  onSelectEquipment,
  onSelectTab,
  onOpenOverview,
  onAddEquipment,
  onNavigate,
  onLogout,
  children,
}: Props) {
  return (
    <div className="app-shell">
      <header className="appbar">
        <EquipmentSwitcher
          equipments={equipments}
          currentEquipmentId={currentEquipmentId}
          onSelectEquipment={onSelectEquipment}
          onOpenOverview={onOpenOverview}
          onAddEquipment={onAddEquipment}
        />
        <div className="appbar-actions">
          <NotificationBell onNavigate={onNavigate} />
          <UserMenu member={member} onLogout={onLogout} />
        </div>
      </header>

      <main className="app-main">{children}</main>

      <nav className="tabbar" aria-label="Sections de l’équipement">
        {TABS.map(({ id, label }) => {
          const Icone = TAB_ICONS[id];
          return (
            <button
              key={id}
              type="button"
              aria-current={id === tab ? 'page' : undefined}
              onClick={() => onSelectTab(id)}
            >
              <Icone size={22} />
              <span className="tabbar-label">{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
