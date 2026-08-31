/**
 * Précision retenue pour un compteur : deux décimales. Les compteurs horaires
 * comme les kilométrages se saisissent au dixième ; deux décimales laissent la
 * marge nécessaire sans jamais exposer le bruit du calcul flottant.
 */
const DECIMALS = 2;

/**
 * Arrondit une valeur de compteur (relevé, durée, seuil) à sa précision utile.
 *
 * Les additions et soustractions de compteurs se font en flottant : « 164 + 1,3 »
 * puis « 165,3 − 164 » redonne 1.3000000000000114, illisible tel quel. Tout
 * calcul de compteur passe donc par cet arrondi, à l'écriture comme à la lecture.
 */
export function roundMeterValue(value: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  return Number(value.toFixed(DECIMALS));
}
