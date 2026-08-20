import { IconPlus } from './icons';

interface Props {
  /**
   * Ce que fait le bouton, dit en toutes lettres : un « + » seul ne dit rien à un lecteur
   * d'écran. Chaque écran donne donc son action à lui (« Réserver un créneau »…), pas « Ajouter ».
   */
  label: string;
  onClick: () => void;
}

/**
 * Bouton d'action flottant : l'action principale de l'écran, posée en bas à droite sous le pouce,
 * au lieu d'être à chercher quelque part dans le flux de la page.
 *
 * Il se pose au-dessus de la barre basse — jamais dessous — et passe sous les modales, qui prennent
 * la main quand elles s'ouvrent. Le rendre hors de la barre d'app est indispensable : celle-ci est
 * `sticky` avec un `z-index`, donc elle piégerait le bouton dans son contexte d'empilement.
 */
export function Fab({ label, onClick }: Props) {
  return (
    <button type="button" className="fab" aria-label={label} title={label} onClick={onClick}>
      <IconPlus size={26} />
    </button>
  );
}
