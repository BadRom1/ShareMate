import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { ChecklistItem, Member } from '../api';
import { formatDateTime, formatRelative } from '../format';
import { pickInitialEquipmentId, setLastEquipmentId } from '../lastEquipment';
import { clearErrors, errorMessage, firstError, useApiResource } from '../useApiResource';
import {
  IconBack,
  IconCheck,
  IconCheckSquare,
  IconChecklist,
  IconClose,
  IconEdit,
  IconPlus,
  IconReset,
  IconSquare,
  IconTrash,
} from '../components/icons';

interface Props {
  members: Member[];
  currentMemberId: string;
  /** Équipement présélectionné (arrivée depuis un lien). */
  initialEquipmentId?: string | null;
}

/**
 * Checklists par équipement : liste des checklists, puis vue d'une checklist avec ses points.
 * Une checklist appartient au cercle, pas à son créateur : tout membre du cercle peut la
 * remplir, la renommer, en modifier la structure et la supprimer. Le nom du créateur et
 * celui de l'auteur de chaque coche restent affichés comme trace.
 *
 * Seuls les équipements dont l'utilisateur fait partie du cercle sont proposés : hors du
 * cercle, rien n'est visible (le serveur applique la même règle, y compris en lecture).
 */
export function ChecklistsPage({ members, currentMemberId, initialEquipmentId }: Props) {
  const [selectedId, setSelectedId] = useState('');
  const [openChecklistId, setOpenChecklistId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Formulaire de nouvelle checklist.
  const [showNew, setShowNew] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newItems, setNewItems] = useState('');

  // Édition inline (titre de la checklist ou libellé d'un point) + ajout de point.
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [newItemLabel, setNewItemLabel] = useState('');

  const equipmentsResource = useApiResource(
    useCallback(async () => {
      // Filtré au cercle de l'utilisateur : un équipement qu'il ne partage pas n'a pas à
      // apparaître, et ses checklists lui seraient de toute façon refusées par l'API.
      const mine = (await api.listEquipments()).filter((e) => e.memberIds.includes(currentMemberId));
      setSelectedId((id) =>
        pickInitialEquipmentId(mine, currentMemberId, { current: id, deepLink: initialEquipmentId }),
      );
      return mine;
    }, [currentMemberId, initialEquipmentId]),
  );

  const checklistsResource = useApiResource(
    useCallback(async () => (selectedId ? api.listChecklists(selectedId) : []), [selectedId]),
  );

  const itemsResource = useApiResource(
    useCallback(async () => (openChecklistId ? api.listChecklistItems(openChecklistId) : []), [openChecklistId]),
  );

  const equipments = equipmentsResource.data ?? [];
  const checklists = checklistsResource.data ?? [];
  const items = itemsResource.data ?? [];
  const error = actionError ?? firstError(equipmentsResource, checklistsResource, itemsResource);

  const selected = equipments.find((e) => e.id === selectedId) ?? null;
  const openChecklist = checklists.find((c) => c.id === openChecklistId) ?? null;
  const circle = useMemo(
    () => (selected ? members.filter((m) => selected.memberIds.includes(m.id)) : []),
    [selected, members],
  );
  const checkedCount = items.filter((i) => i.checkedAt !== null).length;

  // Changement de checklist : on repart d'une vue propre.
  useEffect(() => {
    setEditingItemId(null);
    setRenaming(false);
    setNewItemLabel('');
  }, [openChecklistId]);

  // Mémorise l'équipement consulté (partagé avec les autres onglets).
  useEffect(() => {
    if (selectedId) setLastEquipmentId(selectedId);
  }, [selectedId]);

  // Échap ferme la modale de création.
  useEffect(() => {
    if (!showNew) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowNew(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showNew]);

  function memberName(id: string) {
    return members.find((m) => m.id === id)?.name ?? id;
  }

  function fail(e: unknown) {
    setActionError(errorMessage(e));
  }

  async function createChecklist(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedId || !newTitle.trim()) return;
    setBusy(true);
    setActionError(null);
    try {
      // Saisie multiligne : une ligne = un point de contrôle.
      const labels = newItems.split('\n');
      const checklist = await api.createChecklist(selectedId, newTitle.trim(), labels);
      setNewTitle('');
      setNewItems('');
      setShowNew(false);
      await checklistsResource.reload();
      setOpenChecklistId(checklist.id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function removeChecklist(id: string) {
    if (!confirm('Supprimer cette checklist et tous ses points ?')) return;
    try {
      await api.deleteChecklist(id);
      if (openChecklistId === id) setOpenChecklistId(null);
      await checklistsResource.reload();
    } catch (e) {
      fail(e);
    }
  }

  async function saveRename() {
    if (!openChecklist || !renameDraft.trim()) return;
    try {
      await api.renameChecklist(openChecklist.id, renameDraft.trim());
      setRenaming(false);
      await checklistsResource.reload();
    } catch (e) {
      fail(e);
    }
  }

  async function resetChecklist(id: string) {
    if (!confirm('Décocher tous les points de cette checklist ?')) return;
    try {
      await api.resetChecklist(id);
      await Promise.all([itemsResource.reload(), checklistsResource.reload()]);
    } catch (e) {
      fail(e);
    }
  }

  async function addItem(event: React.FormEvent) {
    event.preventDefault();
    const label = newItemLabel.trim();
    if (!label || !openChecklistId) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.addChecklistItem(openChecklistId, label);
      setNewItemLabel('');
      await Promise.all([itemsResource.reload(), checklistsResource.reload()]);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function toggleItem(item: ChecklistItem) {
    try {
      await api.setChecklistItemChecked(item.id, item.checkedAt === null);
      await Promise.all([itemsResource.reload(), checklistsResource.reload()]);
    } catch (e) {
      fail(e);
    }
  }

  async function saveItemLabel(id: string) {
    if (!editDraft.trim()) return;
    try {
      await api.renameChecklistItem(id, editDraft.trim());
      setEditingItemId(null);
      await itemsResource.reload();
    } catch (e) {
      fail(e);
    }
  }

  async function removeItem(id: string) {
    if (!confirm('Supprimer ce point ?')) return;
    try {
      await api.deleteChecklistItem(id);
      await Promise.all([itemsResource.reload(), checklistsResource.reload()]);
    } catch (e) {
      fail(e);
    }
  }

  if (equipments.length === 0) {
    return (
      <>
        {error && <div className="alert">{error}</div>}
        <p className="empty">Aucun équipement partagé avec vous : les checklists s'organisent par équipement.</p>
      </>
    );
  }

  return (
    <>
      {error && (
        <div
          className="alert"
          onClick={() => {
            setActionError(null);
            clearErrors(equipmentsResource, checklistsResource, itemsResource);
          }}
        >
          {error}
        </div>
      )}

      <div className="card">
        <div className="row" style={{ alignItems: 'center' }}>
          <label className="field" style={{ flex: '0 0 auto', minWidth: '16rem' }}>
            Équipement
            <select
              value={selectedId}
              onChange={(e) => {
                // La checklist ouverte appartient à l'équipement quitté : elle se referme ici.
                setOpenChecklistId(null);
                setSelectedId(e.target.value);
              }}
            >
              {equipments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <p className="muted" style={{ margin: 0 }}>
              Cercle : {circle.map((m) => m.name).join(', ')}
            </p>
          )}
        </div>
      </div>

      <div className={`split-layout ${openChecklist ? 'has-open' : ''}`}>
        <div className="split-main">
          {openChecklist ? (
            ChecklistView()
          ) : (
            <div className="card empty-pane">
              <IconChecklist size={40} />
              <p className="empty" style={{ margin: 0 }}>
                Sélectionnez une checklist à droite ou créez-en une.
              </p>
            </div>
          )}
        </div>

        <aside className="split-aside">
          <div className="card">
            <div className="bell-head">
              <h3
                style={{
                  margin: 0,
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={selected?.name}
              >
                {selected ? selected.name : 'Checklists'}
              </h3>
              <button
                className="icon-btn icon-primary"
                onClick={() => setShowNew(true)}
                title="Nouvelle checklist"
                aria-label="Nouvelle checklist"
              >
                <IconPlus size={20} />
              </button>
            </div>

            {checklists.length === 0 ? (
              <p className="empty">Aucune checklist — créez la première !</p>
            ) : (
              <ul className="side-list">
                {checklists.map((c) => (
                  <li key={c.id} className={`side-row ${c.id === openChecklistId ? 'side-active' : ''}`}>
                    <button className="side-open" onClick={() => setOpenChecklistId(c.id)}>
                      <IconChecklist size={18} />
                      <span className="side-titles">
                        <span className="side-title">{c.title}</span>
                        <span className="muted side-sub">
                          {memberName(c.authorId)} · {c.checkedCount}/{c.itemCount} · {formatRelative(c.updatedAt)}
                        </span>
                      </span>
                    </button>
                    <button
                      className="icon-btn icon-danger"
                      onClick={() => void removeChecklist(c.id)}
                      title="Supprimer la checklist"
                    >
                      <IconTrash size={18} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      {showNew && (
        <div className="modal-backdrop" onClick={() => setShowNew(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3 style={{ margin: 0 }}>Nouvelle checklist</h3>
              <button className="icon-btn" onClick={() => setShowNew(false)} title="Fermer">
                <IconClose size={20} />
              </button>
            </div>
            <form onSubmit={createChecklist} className="modal-form">
              <label className="field">
                Titre
                <input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="ex. Avant utilisation"
                  maxLength={200}
                  autoFocus
                />
              </label>
              <label className="field">
                Points de contrôle <span className="muted">(un par ligne, optionnel)</span>
                <textarea
                  value={newItems}
                  onChange={(e) => setNewItems(e.target.value)}
                  placeholder={'Niveau d’huile\nGasoil\nÉtat des chenilles'}
                  rows={6}
                />
              </label>
              <div className="modal-actions">
                <button type="button" className="ghost" onClick={() => setShowNew(false)}>
                  Annuler
                </button>
                <button type="submit" className="btn-primary" disabled={busy || !newTitle.trim()}>
                  <IconCheck size={18} /> Créer la checklist
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );

  function ChecklistView() {
    if (!openChecklist) return null;
    const total = items.length;
    const percent = total === 0 ? 0 : Math.round((checkedCount / total) * 100);

    return (
      <div className="card">
        <div className="bell-head">
          <button className="icon-btn side-back" onClick={() => setOpenChecklistId(null)} title="Retour aux checklists">
            <IconBack size={20} />
          </button>
          {renaming ? (
            <form
              className="inline-edit"
              onSubmit={(e) => {
                e.preventDefault();
                void saveRename();
              }}
            >
              <input value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} maxLength={200} autoFocus />
              <button type="submit" className="icon-btn icon-confirm" title="Valider">
                <IconCheck size={18} />
              </button>
              <button type="button" className="icon-btn" onClick={() => setRenaming(false)} title="Annuler">
                <IconClose size={18} />
              </button>
            </form>
          ) : (
            <>
              <h3 style={{ margin: 0, flex: 1 }}>{openChecklist.title}</h3>
              <div className="icon-group">
                {checkedCount > 0 && (
                  <button
                    className="icon-btn icon-edit"
                    onClick={() => void resetChecklist(openChecklist.id)}
                    title="Tout décocher"
                    aria-label="Tout décocher"
                  >
                    <IconReset size={18} />
                  </button>
                )}
                <button
                  className="icon-btn icon-edit"
                  onClick={() => {
                    setRenameDraft(openChecklist.title);
                    setRenaming(true);
                  }}
                  title="Renommer la checklist"
                >
                  <IconEdit size={18} />
                </button>
                <button
                  className="icon-btn icon-danger"
                  onClick={() => void removeChecklist(openChecklist.id)}
                  title="Supprimer la checklist"
                >
                  <IconTrash size={18} />
                </button>
              </div>
            </>
          )}
        </div>

        {/* Trace du créateur : la liste latérale l'affiche aussi, mais elle est masquée sur mobile. */}
        <p className="muted check-author">Créée par {memberName(openChecklist.authorId)}</p>

        <div className={`progress ${total > 0 && checkedCount === total ? 'progress-done' : ''}`}>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <span>
            {checkedCount}/{total}
          </span>
        </div>

        {total === 0 ? (
          <p className="empty">Aucun point — ajoutez le premier ci-dessous.</p>
        ) : (
          <ul className="check-items">
            {items.map((item) => {
              const checked = item.checkedAt !== null;
              return (
                <li key={item.id} className="check-item">
                  {editingItemId === item.id ? (
                    <form
                      className="inline-edit"
                      style={{ flex: 1 }}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveItemLabel(item.id);
                      }}
                    >
                      <input
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        maxLength={200}
                        autoFocus
                      />
                      <button type="submit" className="icon-btn icon-confirm" title="Enregistrer">
                        <IconCheck size={18} />
                      </button>
                      <button type="button" className="icon-btn" onClick={() => setEditingItemId(null)} title="Annuler">
                        <IconClose size={18} />
                      </button>
                    </form>
                  ) : (
                    <>
                      <button
                        className={`check-toggle ${checked ? 'checked' : ''}`}
                        onClick={() => void toggleItem(item)}
                        title={checked ? 'Décocher' : 'Cocher'}
                      >
                        {checked ? <IconCheckSquare size={20} /> : <IconSquare size={20} />}
                        <span className="check-label">
                          <span className="check-text">{item.label}</span>
                          {checked && item.checkedById && (
                            <span className="check-by">
                              {memberName(item.checkedById)} · {formatDateTime(item.checkedAt!)}
                            </span>
                          )}
                        </span>
                      </button>
                      <span className="icon-group">
                        <button
                          className="icon-btn icon-edit"
                          onClick={() => {
                            setEditingItemId(item.id);
                            setEditDraft(item.label);
                          }}
                          title="Modifier le point"
                        >
                          <IconEdit size={16} />
                        </button>
                        <button
                          className="icon-btn icon-danger"
                          onClick={() => void removeItem(item.id)}
                          title="Supprimer le point"
                        >
                          <IconTrash size={16} />
                        </button>
                      </span>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <form onSubmit={addItem} className="check-add">
          <input
            value={newItemLabel}
            onChange={(e) => setNewItemLabel(e.target.value)}
            placeholder="Ajouter un point…"
            maxLength={200}
          />
          <button
            type="submit"
            className="icon-btn icon-primary"
            disabled={busy || newItemLabel.trim().length === 0}
            title="Ajouter"
            aria-label="Ajouter le point"
          >
            <IconPlus size={20} />
          </button>
        </form>
      </div>
    );
  }
}
