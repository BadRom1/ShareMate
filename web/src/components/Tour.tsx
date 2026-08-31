import { useCallback, useEffect, useRef, useState } from 'react';
import type { MaintenanceSection, Tab } from '../navigation';
import { useEscape } from '../useEscape';

/**
 * Visite guidée : quelques bulles posées sur la coque, qui nomment les six gestes du quotidien.
 *
 * Elle s'ouvre au tout premier usage, devant un parc le plus souvent vide. Ses repères sont pris
 * sur la coque — sélecteur, cloche, barre basse — qui, elle, est toujours là : le halo a bien une
 * cible même sans équipement. Ce sont les écrans décrits qui sont vides, et les textes nomment
 * donc la section plutôt que de désigner un bouton qui n'y est pas encore. La bulle centrée reste
 * le repli quand une cible manque, plutôt que de la poser n'importe où.
 */

const CLÉ = 'sharemate.tour.seen';

/** La visite a-t-elle déjà été lancée sur cet appareil ? */
export function visiteDéjàFaite(): boolean {
  try {
    return localStorage.getItem(CLÉ) !== null;
  } catch {
    // Stockage indisponible (mode privé) : mieux vaut ne pas la proposer que la reproposer sans fin.
    return true;
  }
}

export function marquerVisiteFaite(): void {
  try {
    localStorage.setItem(CLÉ, '1');
  } catch {
    /* stockage indisponible (mode privé) : on ignore silencieusement */
  }
}

export interface ÉtapeVisite {
  id: string;
  titre: string;
  corps: string;
  /** Élément de la coque à désigner, marqué `data-tour`. Absent de l'écran : la bulle se centre. */
  cible?: string;
  /** Onglet que l'étape ouvre : la visite montre l'écran dont elle parle. */
  tab?: Tab;
  section?: MaintenanceSection;
}

export const ÉTAPES: ÉtapeVisite[] = [
  {
    id: 'equipement',
    titre: 'Un équipement à la fois',
    corps:
      'En haut de l’écran, le nom de l’équipement courant. Tout le reste — agenda, relevés, dépenses, forum — ne parle que de celui-là. Changez d’équipement pour changer d’espace de travail.',
    cible: 'equipment-switcher',
  },
  {
    id: 'reserver',
    titre: 'Réserver un créneau',
    corps:
      'Dans l’onglet Agenda, chacun pose les créneaux pendant lesquels il prend l’équipement. Un début, une fin, et le cercle sait qui l’a et quand il revient.',
    cible: 'tab-agenda',
    tab: 'agenda',
  },
  {
    id: 'releve',
    titre: 'Saisir un relevé de compteur',
    corps:
      'L’onglet Machine tient l’historique d’usage : compteur, carburant, remarques. Notez le relevé après chaque utilisation — c’est ce qui nourrit les statistiques du cercle et déclenche l’alerte d’entretien quand le seuil est dépassé.',
    cible: 'tab-maintenance',
    tab: 'maintenance',
    section: 'usage',
  },
  {
    id: 'depense',
    titre: 'Ajouter une dépense',
    corps:
      'Carburant, réparation, assurance : l’onglet Dépenses enregistre ce que chacun a avancé, avec la photo du justificatif quand il y en a un.',
    cible: 'tab-expenses',
    tab: 'expenses',
  },
  {
    id: 'soldes',
    titre: 'Voir qui doit combien à qui',
    corps:
      'Sous la liste des dépenses, le même onglet calcule les soldes du cercle et propose les remboursements les plus courts : qui verse quoi, et à qui.',
    cible: 'tab-expenses',
    tab: 'expenses',
  },
  {
    id: 'notifications',
    titre: 'Activer les notifications',
    corps:
      'La cloche, en haut à droite, réunit ce qui bouge sur vos équipements. Ouvrez-la pour choisir ce qui vous est signalé et autoriser les alertes sur cet appareil.',
    cible: 'notifications',
  },
  {
    id: 'forum',
    titre: 'Poser une question au cercle',
    corps:
      'Chaque équipement a son forum : une panne à signaler, une date à caler, un conseil d’entretien. Les échanges restent attachés à l’équipement concerné.',
    cible: 'tab-forum',
    tab: 'forum',
  },
];

/** Position d'une cible à l'écran, telle qu'elle vient d'être mesurée. */
interface Ancre {
  haut: number;
  gauche: number;
  largeur: number;
  hauteur: number;
}

function mêmeAncre(a: Ancre | null, b: Ancre | null): boolean {
  if (a === null || b === null) return a === b;
  return a.haut === b.haut && a.gauche === b.gauche && a.largeur === b.largeur && a.hauteur === b.hauteur;
}

interface Props {
  /** Onglet — et sous-section — que l'étape courante veut voir à l'écran. */
  onSelectTab: (tab: Tab, section?: MaintenanceSection) => void;
  /** Visite terminée, passée ou interrompue : dans les trois cas elle ne revient pas d'elle-même. */
  onClose: () => void;
}

export function Tour({ onSelectTab, onClose }: Props) {
  const [rang, setRang] = useState(0);
  const [ancre, setAncre] = useState<Ancre | null>(null);
  const bulleRef = useRef<HTMLDivElement | null>(null);
  const étape = ÉTAPES[rang];
  const dernière = rang === ÉTAPES.length - 1;

  useEscape(onClose);

  // Une visite paraît une fois : elle se note faite en s'ouvrant, pas en s'achevant. Sinon un
  // rechargement en cours de route la relancerait depuis le début, indéfiniment.
  useEffect(() => {
    marquerVisiteFaite();
  }, []);

  /**
   * Le changement d'onglet est le seul effet de bord de la visite, et il ne doit se produire
   * qu'au changement d'étape. La demande passe donc par une référence : l'appelant la redéclare
   * à chaque rendu, et en dépendre relancerait l'effet à l'infini — chaque appel provoquant le
   * rendu suivant.
   */
  const demanderLOnglet = useRef(onSelectTab);
  useEffect(() => {
    demanderLOnglet.current = onSelectTab;
  });

  useEffect(() => {
    if (étape.tab) demanderLOnglet.current(étape.tab, étape.section);
  }, [étape]);

  useEffect(() => {
    let abandonné = false;

    function mesurer() {
      const cible = étape.cible ? document.querySelector<HTMLElement>(`[data-tour="${étape.cible}"]`) : null;
      let mesure: Ancre | null = null;
      if (cible) {
        // Le contenu défile dans `.app-main` : la cible peut être hors de vue au moment où on la vise.
        cible.scrollIntoView({ block: 'center' });
        const rect = cible.getBoundingClientRect();
        // Un rectangle plat ne désigne rien — élément masqué, ou pas encore posé par le navigateur.
        if (rect.width > 0 && rect.height > 0) {
          mesure = { haut: rect.top, gauche: rect.left, largeur: rect.width, hauteur: rect.height };
        }
      }
      setAncre((précédente) => (mêmeAncre(précédente, mesure) ? précédente : mesure));
    }

    // L'onglet demandé par l'étape n'est pas encore rendu à ce tick : mesurer tout de suite
    // viserait l'écran précédent, ou rien du tout.
    const image = requestAnimationFrame(() => {
      if (!abandonné) mesurer();
    });
    window.addEventListener('resize', mesurer);
    return () => {
      abandonné = true;
      cancelAnimationFrame(image);
      window.removeEventListener('resize', mesurer);
    };
  }, [étape]);

  // Le focus est prêté, pas pris : la visite le rend en partant à qui l'avait — l'entrée du menu
  // qui l'a relancée, par exemple. Déclaré avant la prise de focus, sinon il se rendrait la bulle.
  useEffect(() => {
    const précédent = document.activeElement as HTMLElement | null;
    return () => précédent?.focus?.();
  }, []);

  // Le clavier suit la visite : chaque étape rend la main à la bulle qui vient de paraître.
  useEffect(() => {
    bulleRef.current?.focus();
  }, [rang]);

  /**
   * Tabulation retenue dans la bulle. Le voile arrête la souris, mais rien n'arrête le clavier :
   * sans ce tour de piste, on ressort de la visite dans une coque qu'elle continue de commenter,
   * et on y déclenche justement l'action qu'elle était en train d'expliquer. La bulle ne contient
   * que ses propres boutons, écrits ici : inutile d'aller chercher plus loin qu'eux.
   */
  useEffect(() => {
    function surTabulation(événement: KeyboardEvent) {
      const bulle = bulleRef.current;
      if (événement.key !== 'Tab' || !bulle) return;
      const boutons = [...bulle.querySelectorAll('button')];
      if (boutons.length === 0) return;
      const premier = boutons[0];
      const dernier = boutons[boutons.length - 1];
      const actif = document.activeElement;
      if (événement.shiftKey && (actif === premier || actif === bulle)) {
        dernier.focus();
        événement.preventDefault();
      } else if (!événement.shiftKey && actif === dernier) {
        premier.focus();
        événement.preventDefault();
      }
    }
    window.addEventListener('keydown', surTabulation);
    return () => window.removeEventListener('keydown', surTabulation);
  }, []);

  const avancer = useCallback(() => {
    setRang((courant) => Math.min(courant + 1, ÉTAPES.length - 1));
  }, []);

  const reculer = useCallback(() => {
    setRang((courant) => Math.max(courant - 1, 0));
  }, []);

  /**
   * La bulle se pose sous la cible, ou au-dessus quand celle-ci occupe le bas de l'écran — la
   * barre basse, justement, d'où partent quatre étapes sur sept.
   */
  const style: React.CSSProperties | undefined =
    ancre === null
      ? undefined
      : ancre.haut > window.innerHeight / 2
        ? { bottom: `${Math.round(window.innerHeight - ancre.haut + 12)}px` }
        : { top: `${Math.round(ancre.haut + ancre.hauteur + 12)}px` };

  return (
    <div className={ancre ? 'tour-overlay' : 'tour-overlay tour-overlay-plein'}>
      {ancre && (
        <div
          className="tour-halo"
          aria-hidden="true"
          style={{
            top: `${Math.round(ancre.haut)}px`,
            left: `${Math.round(ancre.gauche)}px`,
            width: `${Math.round(ancre.largeur)}px`,
            height: `${Math.round(ancre.hauteur)}px`,
          }}
        />
      )}

      <div
        className={ancre ? 'tour-bubble' : 'tour-bubble tour-bubble-centre'}
        style={style}
        role="dialog"
        aria-label="Visite guidée"
        tabIndex={-1}
        ref={bulleRef}
      >
        <p className="tour-progress">
          {rang + 1} / {ÉTAPES.length}
        </p>
        <h3 className="tour-title">{étape.titre}</h3>
        <p className="tour-body">{étape.corps}</p>
        <div className="tour-actions">
          <button type="button" className="link" onClick={onClose}>
            Passer
          </button>
          {rang > 0 && (
            <button type="button" className="link" onClick={reculer}>
              Précédent
            </button>
          )}
          <button type="button" className="primary tour-next" onClick={dernière ? onClose : avancer}>
            {dernière ? 'Terminer' : 'Suivant'}
          </button>
        </div>
      </div>
    </div>
  );
}
