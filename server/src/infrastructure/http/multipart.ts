import type { FastifyRequest } from 'fastify';
import { DomainError } from '../../domain/shared/domain-error.js';

/**
 * Lecture des corps `multipart/form-data`, partagée par les routes qui reçoivent un fichier
 * accompagné de métadonnées (dépôt d'un document, message avec pièce jointe).
 *
 * Ces champs-là échappent au schéma JSON qui borne toutes les autres entrées : un corps multipart
 * n'est pas un document JSON. Leurs bornes sont donc posées ici, et le reste de la validation
 * revient au domaine, qui la fait de toute façon.
 */

/**
 * Longueur maximale d'un champ texte d'un corps multipart. Généreuse : le corps d'un message
 * passe par là.
 */
const MAX_FIELD_LENGTH = 10_000;

export interface MultipartUpload {
  fields: Record<string, string>;
  file: { filename: string; content: Buffer } | null;
}

/**
 * Lit le corps en entier — champs et fichier, dans n'importe quel ordre. `request.file()` n'expose
 * que les champs reçus **avant** le fichier : l'ordre des parties dépendrait alors du client, et un
 * formulaire réordonné perdrait silencieusement une métadonnée.
 */
export async function readUpload(request: FastifyRequest, maxFileBytes: number): Promise<MultipartUpload> {
  const upload: MultipartUpload = { fields: {}, file: null };
  for await (const part of request.parts({ limits: { fileSize: maxFileBytes, files: 1, fields: 10 } })) {
    if (part.type === 'file') {
      upload.file = { filename: part.filename, content: await part.toBuffer() };
    } else if (typeof part.value === 'string') {
      // Un champ trop long est refusé, pas ignoré : passé sous silence, un `name` démesuré
      // deviendrait « pas de nom » et un `equipmentId` démesuré, « champ obligatoire » — deux
      // messages qui décrivent autre chose que ce qui s'est passé.
      if (part.value.length > MAX_FIELD_LENGTH) {
        throw new DomainError(`Le champ « ${part.fieldname} » dépasse ${MAX_FIELD_LENGTH} caractères.`);
      }
      upload.fields[part.fieldname] = part.value;
    }
  }
  return upload;
}

export function requiredField(fields: Record<string, string>, field: string): string {
  const value = fields[field]?.trim();
  if (!value) {
    throw new DomainError(`Le champ « ${field} » est obligatoire.`);
  }
  return value;
}

/** Champ dont la valeur doit appartenir à une énumération du domaine. */
export function enumField<T extends string>(fields: Record<string, string>, field: string, allowed: readonly T[]): T {
  const value = requiredField(fields, field) as T;
  if (!allowed.includes(value)) {
    throw new DomainError(`Le champ « ${field} » n’accepte que : ${allowed.join(', ')}`);
  }
  return value;
}
