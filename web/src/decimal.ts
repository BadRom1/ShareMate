/**
 * Saisie des nombres à décimales.
 *
 * `<input type="number">` refuse la virgule sur une partie des claviers mobiles
 * français : le champ se vide sans le dire, et la saisie est perdue. Les champs
 * décimaux sont donc de simples champs texte (clavier numérique), où la virgule
 * vaut le point — c'est ce module qui fait la conversion.
 */

/** Brouillon accepté pendant la frappe : vide, « 1 », « 1, », « 1,3 », « ,5 ». */
const DECIMAL_DRAFT = /^\d*[.,]?\d*$/;

export function isDecimalDraft(value: string): boolean {
  return DECIMAL_DRAFT.test(value);
}

/** Nombre saisi, virgule comprise. `null` si le champ est vide ou inexploitable. */
export function parseDecimal(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (normalized === '' || normalized === '.') return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * Valeur pré-remplie dans un champ décimal : virgule française et rien d'autre
 * (pas de séparateur de milliers, qui rendrait la saisie illisible à la relecture).
 */
export function decimalInputValue(value: number): string {
  return String(value).replace('.', ',');
}

/** Décimales effectivement saisies (« 90,555 » → 3), pour refuser ce qu'un arrondi trahirait. */
export function decimalPlaces(value: string): number {
  const [, decimales = ''] = value.trim().replace(',', '.').split('.');
  return decimales.length;
}
