import { Document, normalizeDocumentUrl } from '../domain/document/document.js';
import type { DocumentCategory, DocumentContent } from '../domain/document/document.js';
import { DomainError, NotFoundError } from '../domain/shared/domain-error.js';
import { equipmentForMember } from './equipment-access.js';
import { documentNotFound, purgeOrphanObjects } from './document-access.js';
import { assertStorageAvailable } from './equipment-storage.js';
import type {
  Clock,
  DocumentRepository,
  EquipmentRepository,
  IdGenerator,
  MessageRepository,
  ObjectStorage,
} from './ports.js';

export interface AddDocumentInput {
  equipmentId: string;
  /** Nom affiché ; laissé vide, il retombe sur le nom du fichier ou le domaine du lien. */
  name?: string | null;
  category: DocumentCategory;
  content: DocumentContent;
}

export interface UpdateDocumentInput {
  name?: string;
  category?: DocumentCategory;
}

/**
 * Documents rattachés à un équipement : fichiers déposés dans le stockage d'objets et liens
 * externes, dans la même liste. Un document appartient au cercle et non à son déposant — tout
 * membre peut le renommer, le reclasser et le supprimer, comme pour une checklist.
 *
 * Le cercle de l'équipement est la frontière d'accès : hors du cercle, rien n'est visible ni
 * modifiable — la lecture est contrôlée comme l'écriture, et le contenu d'un fichier ne se lit
 * que par le document qui le nomme.
 */
export class DocumentService {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly equipments: EquipmentRepository,
    // Le dossier et les discussions se partagent la place d'un équipement : la mesurer suppose
    // de voir les deux.
    private readonly messages: MessageRepository,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly storage?: ObjectStorage,
  ) {}

  async addDocument(input: AddDocumentInput, requesterId: string): Promise<Document> {
    await this.assertInCircle(input.equipmentId, requesterId);
    const content = normalizeContent(input.content);
    // Un objet appartient à un seul document. Aujourd'hui aucune route n'accepte de clé venant du
    // client — elle naît dans le handler, au retour de `storage.save` —, donc l'invariant tient de
    // lui-même ; ce garde est ce qui le fait tenir encore si une route en acceptait une un jour,
    // car deux documents nommant le même objet rendraient sa purge ambiguë.
    if (content.type === 'FILE' && (await this.documents.findByStorageKey(content.storageKey)).length > 0) {
      throw new DomainError('Ce fichier est déjà rattaché à un document.');
    }
    const document = Document.create({
      id: this.idGenerator.next(),
      equipmentId: input.equipmentId,
      authorId: requesterId,
      name: input.name?.trim() || defaultName(content),
      category: input.category,
      content,
      createdAt: this.clock.now(),
    });
    await this.documents.save(document);
    return document;
  }

  async listDocuments(equipmentId: string, requesterId: string): Promise<Document[]> {
    await this.assertInCircle(equipmentId, requesterId);
    return this.documents.findByEquipmentId(equipmentId);
  }

  async updateDocument(id: string, requesterId: string, changes: UpdateDocumentInput): Promise<Document> {
    const document = await this.documentForMember(id, requesterId);
    const updated = document.update(changes);
    await this.documents.save(updated);
    return updated;
  }

  async deleteDocument(id: string, requesterId: string): Promise<void> {
    const document = await this.documentForMember(id, requesterId);
    await this.documents.delete(id);
    await purgeOrphanObjects(this.documents, this.storage, [document]);
  }

  /**
   * Document demandé, une fois le demandeur reconnu dans le cercle de son équipement. L'adapter
   * HTTP s'en sert aussi pour autoriser la lecture du fichier avant de le servir : lui seul sait
   * où l'objet est rangé, la règle d'accès reste ici.
   */
  async documentForMember(id: string, requesterId: string): Promise<Document> {
    const absent = documentNotFound(id);
    const document = await this.documents.findById(id);
    if (!document) throw new NotFoundError(absent);
    await this.assertInCircle(document.equipmentId, requesterId, absent);
    return document;
  }

  /**
   * Autorise un téléversement **avant** que l'octet n'atteigne le stockage : appartenance au
   * cercle, puis place restante. Refuser après coup laisserait dans le bucket un objet que plus
   * aucun document ne nommerait — c'est-à-dire exactement ce que la purge ne sait pas rattraper.
   */
  async assertCanStore(equipmentId: string, requesterId: string, sizeBytes: number): Promise<void> {
    await this.assertInCircle(equipmentId, requesterId);
    await assertStorageAvailable(this.documents, this.messages, equipmentId, sizeBytes);
  }

  /** Tout accès — lecture comme écriture — exige d'appartenir au cercle de l'équipement. */
  private async assertInCircle(equipmentId: string, memberId: string, absent?: string): Promise<void> {
    await equipmentForMember(this.equipments, equipmentId, memberId, absent);
  }
}

/** L'adresse d'un lien est normalisée ici pour que le nom par défaut puisse s'y fier. */
function normalizeContent(content: DocumentContent): DocumentContent {
  return content.type === 'LINK' ? { type: 'LINK', url: normalizeDocumentUrl(content.url) } : content;
}

/**
 * Nom affiché à défaut de saisie. Le nom d'origine du fichier — ou le domaine du lien — reste
 * bien plus parlant qu'un « Document sans titre », et se corrige ensuite d'un renommage.
 */
function defaultName(content: DocumentContent): string {
  return content.type === 'FILE' ? content.fileName : new URL(content.url).hostname;
}
