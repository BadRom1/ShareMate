/**
 * Mémorise le dernier équipement consulté (partagé entre les onglets Discussions
 * et Usage), afin d'y revenir par défaut à la prochaine ouverture.
 */
const KEY = 'sharemate.lastEquipmentId';

export function getLastEquipmentId(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setLastEquipmentId(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* stockage indisponible (mode privé) : on ignore silencieusement */
  }
}

/**
 * Choisit l'équipement à présélectionner dans une liste.
 * Priorité : équipement déjà sélectionné → deep-link → dernier consulté (s'il
 * existe encore) → premier équipement dont le membre fait partie → premier de la liste.
 */
export function pickInitialEquipmentId(
  list: { id: string; memberIds: string[] }[],
  currentMemberId: string,
  opts: { current?: string; deepLink?: string | null } = {},
): string {
  const exists = (id: string | null | undefined) => !!id && list.some((e) => e.id === id);
  const lastId = getLastEquipmentId();
  return (
    (exists(opts.current) ? opts.current! : '') ||
    (exists(opts.deepLink) ? opts.deepLink! : '') ||
    (exists(lastId) ? lastId! : '') ||
    list.find((e) => e.memberIds.includes(currentMemberId))?.id ||
    list[0]?.id ||
    ''
  );
}
