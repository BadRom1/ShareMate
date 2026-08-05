import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import path from 'node:path';
import { DOCUMENT_CATEGORIES, MAX_DOCUMENT_SIZE_BYTES } from '../../../domain/document/document.js';
import type { DocumentCategory } from '../../../domain/document/document.js';
import { DomainError, NotFoundError } from '../../../domain/shared/domain-error.js';
import { documentNotFound } from '../../../application/document-access.js';
import type { DocumentService } from '../../../application/document-service.js';
import {
  acceptedDocumentExtensions,
  documentContentType,
  supportsDocumentExtension,
} from '../../tech/document-storage.js';
import type { DocumentStorage } from '../../tech/document-storage.js';
import { documentDto } from '../dto.js';
import { limit } from '../rate-limit.js';
import type { RateLimits } from '../rate-limit.js';
import { enumOf, id, idParams, nullableText, object, text } from '../schema.js';
import '../session.js'; // augmentation de type : request.authMember

/** Documents rattachés à un équipement : fichiers déposés dans le stockage d'objets, et liens. */
export interface DocumentRoutesOptions {
  documentService: DocumentService;
  /** Stockage des objets ; absent, seuls les liens sont gérés (aucun fichier à écrire ni à servir). */
  storage?: DocumentStorage;
  rateLimits: RateLimits;
}

const name = nullableText(200);
const category = enumOf(DOCUMENT_CATEGORIES);
/** Même borne que le domaine : le refus vient du schéma avant d'atteindre `new URL`. */
const url = text(2000);

/** Un téléversement porte ses métadonnées en champs multipart, hors de portée d'un schéma JSON. */
interface MultipartUpload {
  fields: Record<string, string>;
  file: { filename: string; content: Buffer } | null;
}

/**
 * Lit le corps multipart en entier — champs et fichier, dans n'importe quel ordre. `request.file()`
 * n'expose que les champs reçus **avant** le fichier : l'ordre des parties dépendrait alors du
 * client, et un formulaire réordonné perdrait silencieusement la catégorie.
 */
async function readUpload(request: FastifyRequest): Promise<MultipartUpload> {
  const upload: MultipartUpload = { fields: {}, file: null };
  for await (const part of request.parts({ limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES, files: 1, fields: 10 } })) {
    if (part.type === 'file') {
      upload.file = { filename: part.filename, content: await part.toBuffer() };
    } else if (typeof part.value === 'string' && part.value.length <= 2000) {
      upload.fields[part.fieldname] = part.value;
    }
  }
  return upload;
}

function requiredField(fields: Record<string, string>, field: string): string {
  const value = fields[field]?.trim();
  if (!value) {
    throw new DomainError(`Le champ « ${field} » est obligatoire.`);
  }
  return value;
}

/** Les champs multipart échappent au schéma JSON : l'énumération est vérifiée à la main. */
function requiredCategory(fields: Record<string, string>): DocumentCategory {
  const value = requiredField(fields, 'category') as DocumentCategory;
  if (!DOCUMENT_CATEGORIES.includes(value)) {
    throw new DomainError(`Le champ « category » n’accepte que : ${DOCUMENT_CATEGORIES.join(', ')}`);
  }
  return value;
}

export const documentRoutes: FastifyPluginAsync<DocumentRoutesOptions> = async (
  app,
  { documentService, storage, rateLimits },
) => {
  app.get<{ Params: { id: string } }>(
    '/api/equipments/:id/documents',
    { schema: { params: idParams } },
    async (request) => {
      const list = await documentService.listDocuments(request.params.id, request.authMember.id);
      return list.map(documentDto);
    },
  );

  app.post<{ Body: { equipmentId: string; url: string; name?: string | null; category: DocumentCategory } }>(
    '/api/documents',
    { schema: { body: object({ equipmentId: id, url, name, category }, ['equipmentId', 'url', 'category']) } },
    async (request, reply) => {
      const document = await documentService.addDocument(
        {
          equipmentId: request.body.equipmentId,
          name: request.body.name,
          category: request.body.category,
          content: { type: 'LINK', url: request.body.url },
        },
        request.authMember.id,
      );
      return reply.status(201).send(documentDto(document));
    },
  );

  app.put<{ Params: { id: string }; Body: { name?: string; category?: DocumentCategory } }>(
    '/api/documents/:id',
    { schema: { params: idParams, body: object({ name: text(200), category }) } },
    async (request) => {
      const { name: newName, category: newCategory } = request.body;
      if (newName === undefined && newCategory === undefined) {
        throw new DomainError('Indiquez le nom ou la catégorie à modifier.');
      }
      return documentDto(await documentService.updateDocument(request.params.id, request.authMember.id, request.body));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/documents/:id',
    { schema: { params: idParams } },
    async (request, reply) => {
      await documentService.deleteDocument(request.params.id, request.authMember.id);
      return reply.status(204).send();
    },
  );

  // Sans stockage configuré, il n'y a ni fichier à écrire ni fichier à servir : ces deux routes
  // n'existent pas, plutôt que d'échouer à l'exécution. Les liens, eux, restent gérés.
  if (!storage) return;

  app.post('/api/documents/file', { config: { rateLimit: limit(rateLimits.sensitive) } }, async (request, reply) => {
    const { fields, file } = await readUpload(request);
    if (!file) {
      return reply.status(400).send({ error: 'Aucun fichier reçu.' });
    }
    const extension = path.extname(file.filename).toLowerCase();
    if (!supportsDocumentExtension(extension)) {
      return reply
        .status(400)
        .send({ error: `Format non accepté. Formats gérés : ${acceptedDocumentExtensions().join(', ')}.` });
    }
    const equipmentId = requiredField(fields, 'equipmentId');
    const category = requiredCategory(fields);
    // Cercle et place disponible d'abord : refuser après l'écriture laisserait dans le bucket un
    // objet que plus aucun document ne nommerait, c'est-à-dire hors de portée de la purge.
    await documentService.assertCanStore(equipmentId, request.authMember.id, file.content.length);

    const storageKey = await storage.save(file.content, extension);
    try {
      const document = await documentService.addDocument(
        {
          equipmentId,
          name: fields.name,
          category,
          content: {
            type: 'FILE',
            storageKey,
            fileName: file.filename,
            // Le type est déduit de l'extension acceptée, jamais celui annoncé par le client :
            // c'est lui qui sera servi en retour, et un `text/html` déclaré s'exécuterait.
            contentType: documentContentType(extension),
            sizeBytes: file.content.length,
          },
        },
        request.authMember.id,
      );
      return reply.status(201).send(documentDto(document));
    } catch (error) {
      // L'objet vient d'être écrit et rien ne le nommera : on le retire avant de propager le refus.
      await storage.delete(storageKey);
      throw error;
    }
  });

  /**
   * Contenu d'un fichier. La clé de l'objet ne circule jamais : on repart de l'identifiant du
   * document, dont l'accès est décidé par le cercle de son équipement. Le stockage répond ensuite
   * dans ses termes — redirection vers une URL signée de courte durée pour un bucket, flux relayé
   * pour le disque local.
   */
  app.get<{ Params: { id: string } }>(
    '/api/documents/:id/content',
    { schema: { params: idParams } },
    async (request, reply) => {
      const absent = documentNotFound(request.params.id);
      const document = await documentService.documentForMember(request.params.id, request.authMember.id);
      // Un lien n'a pas de contenu ici : il s'ouvre chez son hébergeur, pas au travers de l'API.
      if (document.content.type !== 'FILE') {
        throw new NotFoundError(absent);
      }
      const delivery = await storage.open(document.content.storageKey, document.content.fileName);
      if (!delivery) {
        throw new NotFoundError(absent);
      }
      // Jamais de copie durable côté client : la réponse dépend de droits qui peuvent changer, et
      // l'URL signée d'une redirection expire — la rejouer depuis un cache ne donnerait qu'un refus.
      reply.header('Cache-Control', 'private, no-store');
      if (delivery.kind === 'redirect') {
        return reply.redirect(delivery.url, 302);
      }
      return reply
        .header('Content-Disposition', delivery.disposition)
        .header('Content-Length', delivery.size)
        .type(delivery.contentType)
        .send(delivery.stream);
    },
  );
};
