import type { FastifySchemaValidationError } from 'fastify';
import type { SchemaErrorDataVar, SchemaErrorFormatter } from 'fastify/types/schema.js';

/**
 * Briques de schémas JSON pour la validation des requêtes (Ajv, embarqué dans Fastify), et
 * rendu français de leurs refus.
 *
 * Les génériques `app.post<{ Body: … }>` ne sont que des annotations TypeScript : sans schéma,
 * rien n'est vérifié à l'exécution et une entrée mal formée atteint le domaine — voire échoue
 * en 500. Toute route qui lit un corps, un paramètre d'URL ou une querystring en déclare un.
 */

/**
 * Deux écarts assumés aux options Ajv par défaut de Fastify :
 * - `removeAdditional: false` — un champ inconnu doit être refusé, pas supprimé en silence
 *   (`additionalProperties: false` n'émet une erreur qu'à cette condition) ;
 * - `coerceTypes: true` au lieu de `'array'` — un scalaire ne doit pas être promu en liste d'un
 *   élément : `preferences: "x"` est une erreur de type, pas une liste de préférences.
 */
export const AJV_OPTIONS = { removeAdditional: false, coerceTypes: true };

/** Identifiant opaque (UUID côté serveur) : borné, jamais interprété à ce niveau. */
export const id = { type: 'string', minLength: 1, maxLength: 64 };

/** Paramètre d'URL `:id`, de loin le plus fréquent. */
export const idParams = params({ id });

/** Objet fermé : tout champ non déclaré est refusé. */
export function object(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', additionalProperties: false, required, properties };
}

/** Paramètres d'URL : tous obligatoires, puisque portés par le chemin de la route. */
export function params(properties: Record<string, unknown>) {
  return object(properties, Object.keys(properties));
}

export function text(maxLength: number, minLength = 1) {
  return { type: 'string', minLength, maxLength };
}

/** Texte facultatif, que le client peut aussi remettre à `null` pour l'effacer. */
export function nullableText(maxLength: number) {
  return { type: ['string', 'null'], maxLength };
}

export function enumOf(values: readonly string[]) {
  return { type: 'string', enum: [...values] };
}

/** Borne haute commune aux montants et aux compteurs : écarte l'absurde et l'infini. */
const MAX_NUMBER = 1_000_000_000;

export function number(minimum = 0, maximum = MAX_NUMBER) {
  return { type: 'number', minimum, maximum };
}

export function nullableNumber(minimum = 0, maximum = MAX_NUMBER) {
  return { type: ['number', 'null'], minimum, maximum };
}

export const flag = { type: 'boolean' };

export function arrayOf(items: unknown, maxItems: number, minItems = 0) {
  return { type: 'array', minItems, maxItems, items };
}

/**
 * Date ISO 8601 : jour seul (`2026-07-02`, saisi par `<input type="date">`) ou instant
 * (`2026-07-02T08:00:00.000Z`, produit par `toISOString()`). Les deux formes circulent.
 * La validité calendaire reste au domaine, qui rend un message métier.
 */
export const isoDate = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,3})?)?(Z|[+-]\\d{2}:\\d{2})?)?$',
};

/** Nom de fichier d'un justificatif, tel que produit par le téléversement : UUID v4 + extension. */
const RECEIPT_NAME = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(png|jpe?g|webp|pdf)';

/**
 * Chemin d'un justificatif : exactement la forme produite par l'upload, `/uploads/<uuid>.<ext>`.
 * Sans cette borne, un membre place l'URL externe de son choix dans une dépense visible par tout
 * son cercle, que le front rend en lien cliquable — hameçonnage crédible sous couvert de reçu.
 */
export const receiptPath = {
  type: ['string', 'null'],
  maxLength: 60,
  pattern: `^/uploads/${RECEIPT_NAME}$`,
};

/**
 * Paramètre d'URL de la lecture d'un justificatif. Écarte avant tout accès au disque ce que
 * le téléversement n'a pas pu produire — traversées de répertoire comprises.
 */
export const receiptNameParams = params({ name: { type: 'string', pattern: `^${RECEIPT_NAME}$` } });

const SECTIONS: Record<SchemaErrorDataVar, string> = {
  body: 'Corps de requête',
  params: 'Paramètre d’URL',
  querystring: 'Paramètre de requête',
  headers: 'En-tête',
};

const TYPES: Record<string, string> = {
  string: 'texte',
  number: 'nombre',
  integer: 'nombre entier',
  boolean: 'booléen',
  array: 'liste',
  object: 'objet',
  null: 'nul',
};

/** Chemin pointé du champ fautif (`preferences.0.type`), vide à la racine du document. */
function fieldName(error: FastifySchemaValidationError): string {
  const path = error.instancePath.replace(/^\//, '').replace(/\//g, '.');
  const missing = error.params.missingProperty as string | undefined;
  const extra = error.params.additionalProperty as string | undefined;
  return [path, missing ?? extra].filter(Boolean).join('.');
}

function typeLabel(type: unknown): string {
  const wanted = Array.isArray(type) ? type : [type];
  return wanted.map((t) => TYPES[String(t)] ?? String(t)).join(' ou ');
}

function reason(error: FastifySchemaValidationError, subject: string): string {
  const { limit, type, allowedValues } = error.params as {
    limit?: number;
    type?: unknown;
    allowedValues?: unknown[];
  };
  switch (error.keyword) {
    case 'required':
      return `${subject} est obligatoire`;
    case 'additionalProperties':
      return `${subject} n’est pas attendu`;
    case 'type':
      return `${subject} doit être de type ${typeLabel(type)}`;
    case 'enum':
      return `${subject} n’accepte que : ${(allowedValues ?? []).join(', ')}`;
    case 'minLength':
      return limit === 1 ? `${subject} ne peut pas être vide` : `${subject} doit faire au moins ${limit} caractères`;
    case 'maxLength':
      return `${subject} dépasse ${limit} caractères`;
    case 'minItems':
      return `${subject} doit contenir au moins ${limit} élément(s)`;
    case 'maxItems':
    case 'maxProperties':
      return `${subject} dépasse ${limit} entrées`;
    case 'minimum':
    case 'exclusiveMinimum':
      return `${subject} doit valoir au moins ${limit}`;
    case 'maximum':
    case 'exclusiveMaximum':
      return `${subject} doit valoir au plus ${limit}`;
    case 'pattern':
    case 'format':
      return `${subject} n’a pas le format attendu`;
    case 'oneOf':
    case 'anyOf':
      return `${subject} ne correspond à aucune forme acceptée`;
    default:
      return `${subject} est invalide`;
  }
}

/**
 * Refus de schéma en français. Sans ce formateur, le 400 rend le message brut d'Ajv
 * (« body must have required property 'identifier' »), inexploitable par l'utilisateur.
 * Ajv s'arrête à la première erreur (`allErrors: false`) : on la rend, elle seule.
 */
export const schemaErrorFormatter: SchemaErrorFormatter = (errors, dataVar) => {
  const section = SECTIONS[dataVar] ?? 'Requête';
  const first = errors[0];
  if (!first) return new Error(`${section} invalide.`);
  const name = fieldName(first);
  return new Error(`${section} invalide : ${reason(first, name ? `le champ « ${name} »` : 'le contenu')}.`);
};
