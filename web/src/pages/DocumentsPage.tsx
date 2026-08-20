import { useCallback, useEffect, useMemo, useState } from 'react';
import { DOCUMENT_CATEGORIES, api, documentContentUrl } from '../api';
import type { DocumentCategory, Equipment, EquipmentDocument, Member } from '../api';
import { DOCUMENT_CATEGORY_LABELS, formatBytes, formatDate, linkHost } from '../format';
import { clearErrors, errorMessage, firstError, useApiResource } from '../useApiResource';
import {
  IconCheck,
  IconClose,
  IconEdit,
  IconFile,
  IconFolder,
  IconLink,
  IconSearch,
  IconTrash,
  IconUpload,
} from '../components/icons';
import { Modal } from '../components/Modal';
import { Fab } from '../components/Fab';

interface Props {
  members: Member[];
  currentMemberId: string;
  /** Équipement de l'espace de travail courant, choisi dans la coque de l'application. */
  equipment: Equipment;
}

/** Nature en cours d'ajout dans la modale : un fichier à déposer, ou un lien à coller. */
type Draft = 'file' | 'link';

/** Filtre de catégorie ; `*` ne filtre rien. */
type Filter = DocumentCategory | '*';

/**
 * Dossier de documents d'un équipement : fichiers déposés dans le stockage d'objets et liens
 * externes, dans une seule liste. Un document appartient au cercle et non à son déposant — tout
 * membre peut le renommer, le reclasser et le supprimer ; le nom du déposant reste affiché.
 */
export function DocumentsPage({ members, equipment }: Props) {
  const [filter, setFilter] = useState<Filter>('*');
  const [search, setSearch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Modale d'ajout.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState<DocumentCategory>('MANUAL');
  const [newUrl, setNewUrl] = useState('');
  const [newFile, setNewFile] = useState<File | null>(null);

  // Renommage en ligne.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState<DocumentCategory>('OTHER');

  const documentsResource = useApiResource(useCallback(() => api.listDocuments(equipment.id), [equipment.id]));

  const documents = useMemo(() => documentsResource.data ?? [], [documentsResource.data]);
  const error = actionError ?? firstError(documentsResource);

  const circle = useMemo(
    () => members.filter((m) => equipment.memberIds.includes(m.id)),
    [equipment.memberIds, members],
  );

  const counts = useMemo(() => {
    const byCategory = new Map<DocumentCategory, number>();
    for (const document of documents) {
      byCategory.set(document.category, (byCategory.get(document.category) ?? 0) + 1);
    }
    return byCategory;
  }, [documents]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return documents.filter(
      (d) =>
        (filter === '*' || d.category === filter) &&
        (needle.length === 0 ||
          d.name.toLowerCase().includes(needle) ||
          (d.fileName ?? '').toLowerCase().includes(needle)),
    );
  }, [documents, filter, search]);

  // Changement d'équipement : le filtre d'un dossier n'a pas de sens dans le suivant.
  useEffect(() => {
    setFilter('*');
    setSearch('');
    setEditingId(null);
  }, [equipment.id]);

  function memberName(id: string) {
    return members.find((m) => m.id === id)?.name ?? id;
  }

  function fail(e: unknown) {
    setActionError(errorMessage(e));
  }

  function openDraft() {
    setActionError(null);
    setNewName('');
    setNewUrl('');
    setNewFile(null);
    setNewCategory('MANUAL');
    // Le sélecteur de nature ouvre la modale : les deux chemins sont à un clic l'un de l'autre,
    // aucun n'est caché derrière l'autre. Le dépôt de fichier est simplement celui qui est prêt.
    setDraft('file');
  }

  function closeDraft() {
    setDraft(null);
  }

  function chooseFile(file: File | null) {
    setNewFile(file);
    // Le nom du fichier est une proposition, pas une contrainte : il reste modifiable au-dessous.
    if (file && newName.trim().length === 0) setNewName(file.name);
  }

  async function submitDraft(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setActionError(null);
    try {
      if (draft === 'link') {
        await api.addDocumentLink({
          equipmentId: equipment.id,
          url: newUrl.trim(),
          name: newName.trim() || undefined,
          category: newCategory,
        });
      } else if (newFile) {
        await api.uploadDocument(newFile, {
          equipmentId: equipment.id,
          category: newCategory,
          name: newName.trim() || undefined,
        });
      }
      closeDraft();
      await documentsResource.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: string) {
    if (!editName.trim()) return;
    try {
      await api.updateDocument(id, { name: editName.trim(), category: editCategory });
      setEditingId(null);
      await documentsResource.reload();
    } catch (e) {
      fail(e);
    }
  }

  async function removeDocument(document: EquipmentDocument) {
    const quoi = document.kind === 'FILE' ? 'ce fichier' : 'ce lien';
    if (!confirm(`Supprimer ${quoi} « ${document.name} » du dossier ? Cette action est définitive.`)) return;
    try {
      await api.deleteDocument(document.id);
      await documentsResource.reload();
    } catch (e) {
      fail(e);
    }
  }

  return (
    <>
      {error && (
        <div
          className="alert"
          onClick={() => {
            setActionError(null);
            clearErrors(documentsResource);
          }}
        >
          {error}
        </div>
      )}

      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          Cercle : {circle.map((m) => m.name).join(', ')}
        </p>
      </div>

      <div className="card">
        <div className="doc-head">
          <h3>Documents</h3>
          <div className="doc-search">
            <IconSearch size={16} />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher…"
              aria-label="Rechercher un document"
            />
          </div>
        </div>

        <div className="chips">
          <button className={`chip ${filter === '*' ? 'active' : ''}`} onClick={() => setFilter('*')}>
            Tous <span className="count">{documents.length}</span>
          </button>
          {DOCUMENT_CATEGORIES.filter((c) => (counts.get(c) ?? 0) > 0).map((c) => (
            <button key={c} className={`chip ${filter === c ? 'active' : ''}`} onClick={() => setFilter(c)}>
              {DOCUMENT_CATEGORY_LABELS[c]} <span className="count">{counts.get(c)}</span>
            </button>
          ))}
        </div>

        {documents.length === 0 ? (
          <div className="empty-pane">
            <IconFolder size={40} />
            <p className="empty" style={{ margin: 0 }}>
              Dossier vide — déposez un fichier ou ajoutez un lien.
            </p>
          </div>
        ) : visible.length === 0 ? (
          <p className="empty">Aucun document ne correspond.</p>
        ) : (
          <ul className="doc-list">
            {visible.map((document) => (
              <li key={document.id} className="doc-row">
                {editingId === document.id ? (
                  <form
                    className="doc-edit"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveEdit(document.id);
                    }}
                  >
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      maxLength={200}
                      aria-label="Nom du document"
                      autoFocus
                    />
                    <select
                      value={editCategory}
                      onChange={(e) => setEditCategory(e.target.value as DocumentCategory)}
                      aria-label="Catégorie"
                    >
                      {DOCUMENT_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {DOCUMENT_CATEGORY_LABELS[c]}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className="icon-btn icon-confirm" title="Enregistrer">
                      <IconCheck size={18} />
                    </button>
                    <button type="button" className="icon-btn" onClick={() => setEditingId(null)} title="Annuler">
                      <IconClose size={18} />
                    </button>
                  </form>
                ) : (
                  <>
                    <span className={`doc-icon ${document.kind === 'LINK' ? 'is-link' : ''}`}>
                      {document.kind === 'LINK' ? <IconLink size={18} /> : <IconFile size={18} />}
                    </span>
                    {/*
                      Un lien du navigateur, jamais un `fetch` : le contenu d'un fichier est servi
                      par une redirection vers le stockage d'objets, hors de `connect-src 'self'`.
                    */}
                    <a
                      className="doc-open"
                      href={document.kind === 'LINK' ? (document.url ?? '#') : documentContentUrl(document.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span className="doc-name">{document.name}</span>
                      <span className="doc-sub">
                        {DOCUMENT_CATEGORY_LABELS[document.category]}
                        {' · '}
                        {document.kind === 'LINK' ? (
                          <span className="host">{linkHost(document.url ?? '')}</span>
                        ) : (
                          formatBytes(document.sizeBytes ?? 0)
                        )}
                        {' · '}
                        {memberName(document.authorId)}, {formatDate(document.createdAt)}
                      </span>
                    </a>
                    <span className="icon-group">
                      <button
                        className="icon-btn icon-edit"
                        onClick={() => {
                          setEditingId(document.id);
                          setEditName(document.name);
                          setEditCategory(document.category);
                        }}
                        title="Renommer ou reclasser"
                        aria-label={`Renommer ${document.name}`}
                      >
                        <IconEdit size={16} />
                      </button>
                      <button
                        className="icon-btn icon-danger"
                        onClick={() => void removeDocument(document)}
                        title="Supprimer du dossier"
                        aria-label={`Supprimer ${document.name}`}
                      >
                        <IconTrash size={16} />
                      </button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Titre neutre : la nature se choisit dans la boîte, le titre n'en annonce donc aucune. */}
      {draft && (
        <Modal title="Ajouter un document" onClose={closeDraft}>
          <form onSubmit={submitDraft} className="modal-form">
            <div className="nature">
              <button
                type="button"
                className={draft === 'file' ? 'active' : ''}
                onClick={() => setDraft('file')}
                aria-pressed={draft === 'file'}
              >
                <IconFile size={16} /> Fichier
              </button>
              <button
                type="button"
                className={draft === 'link' ? 'active' : ''}
                onClick={() => setDraft('link')}
                aria-pressed={draft === 'link'}
              >
                <IconLink size={16} /> Lien
              </button>
            </div>

            {draft === 'file' ? (
              // Le champ est lui-même la zone de dépôt : un bouton qui le déclencherait ferait
              // deux contrôles pour un geste, et `hidden` le sortirait du parcours clavier.
              <label className={`dropzone ${newFile ? 'filled' : ''}`}>
                <input
                  type="file"
                  className="visually-hidden"
                  aria-label="Fichier à déposer"
                  onChange={(e) => {
                    chooseFile(e.target.files?.[0] ?? null);
                    e.target.value = '';
                  }}
                />
                {newFile ? (
                  <>
                    <IconFile size={22} />
                    <span>
                      <span className="doc-name">{newFile.name}</span>
                      <span className="doc-sub">{formatBytes(newFile.size)} — cliquez pour changer</span>
                    </span>
                  </>
                ) : (
                  <>
                    <IconUpload size={24} />
                    <span>Choisissez un fichier</span>
                    <span className="muted">PDF, image, document bureautique ou texte — 25 Mo maximum</span>
                  </>
                )}
              </label>
            ) : (
              <label className="field">
                Adresse
                <input
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  placeholder="https://…"
                  maxLength={2000}
                  autoFocus
                />
              </label>
            )}

            <label className="field">
              Nom affiché {draft === 'file' && <span className="muted">(le nom du fichier par défaut)</span>}
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="ex. Manuel d’utilisation"
                maxLength={200}
              />
            </label>

            <label className="field">
              Catégorie
              <select value={newCategory} onChange={(e) => setNewCategory(e.target.value as DocumentCategory)}>
                {DOCUMENT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {DOCUMENT_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>

            <div className="modal-actions">
              <button type="button" className="ghost" onClick={closeDraft}>
                Annuler
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={busy || (draft === 'file' ? !newFile : newUrl.trim().length === 0)}
              >
                <IconCheck size={18} /> {busy ? 'Envoi…' : 'Ajouter au dossier'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Seul chemin d'ajout de l'écran, fichier comme lien : le libellé couvre les deux natures. */}
      <Fab label="Ajouter un document" onClick={openDraft} />
    </>
  );
}
