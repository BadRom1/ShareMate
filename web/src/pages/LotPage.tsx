import { useCallback, useState } from 'react';
import { api } from '../api';
import type { Equipment, SubEquipment } from '../api';
import { errorMessage, useApiResource } from '../useApiResource';
import { IconCheck, IconClose, IconEdit, IconPlus, IconTrash } from '../components/icons';

interface Props {
  /** Équipement de l'espace de travail courant, choisi dans la coque de l'application. */
  equipment: Equipment;
}

const EMPTY_FORM = { name: '', quantity: '1', notes: '' };

/**
 * Contenu du lot d'un équipement : ce qui part avec lui — la remorque de la minipelle, ses godets,
 * sa pompe à graisse, un jerrican. C'est un inventaire, pas un équipement en réduction : rien ici
 * ne se réserve ni ne porte de dépense, tout cela reste au niveau de l'équipement.
 *
 * C'est la liste qu'on relit avant de rendre la machine, d'où sa place dans l'onglet de
 * l'équipement plutôt que dans la gestion du parc.
 *
 * Le lot appartient au cercle : tout membre le complète, le corrige et le retire, quel qu'ait été
 * l'auteur de la saisie (le serveur applique la même règle).
 */
export function LotPage({ equipment }: Props) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const resource = useApiResource(useCallback(() => api.listSubEquipments(equipment.id), [equipment.id]));

  const items = resource.data ?? [];
  const error = actionError ?? resource.error;

  /** Écriture suivie d'une relecture ; l'échec s'affiche dans le bandeau de la page. */
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      await resource.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function quantityOf(value: string): number {
    const parsed = Number(value);
    // Un champ vidé vaut « un exemplaire », comme une quantité non renseignée à la création.
    return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const name = form.name.trim();
    if (!name) return;
    await run(async () => {
      await api.addSubEquipment({
        equipmentId: equipment.id,
        name,
        quantity: quantityOf(form.quantity),
        notes: form.notes.trim() || null,
      });
      setForm(EMPTY_FORM);
    });
  }

  async function saveEdit(event: React.FormEvent) {
    event.preventDefault();
    const name = draft.name.trim();
    if (!editingId || !name) return;
    await run(async () => {
      await api.updateSubEquipment(editingId, {
        name,
        quantity: quantityOf(draft.quantity),
        notes: draft.notes.trim() || null,
      });
      setEditingId(null);
    });
  }

  // Retiré sans confirmation : la ligne se resaisit en deux secondes. Les modales de l'application
  // sont réservées aux pertes irréversibles (l'équipement, son historique, le cercle).
  async function remove(id: string) {
    await run(async () => {
      await api.deleteSubEquipment(id);
      if (editingId === id) setEditingId(null);
    });
  }

  function startEdit(item: SubEquipment) {
    setEditingId(item.id);
    setDraft({ name: item.name, quantity: String(item.quantity), notes: item.notes ?? '' });
  }

  return (
    <>
      {error && <div className="alert">{error}</div>}

      <div className="card">
        {items.length === 0 ? (
          <p className="empty">Le lot est vide.</p>
        ) : (
          <ul className="lot-list">
            {items.map((item) => (
              <li key={item.id} className="lot-row">
                {editingId === item.id ? (
                  <form className="lot-form" onSubmit={saveEdit}>
                    <input
                      className="lot-name-input"
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      aria-label="Nom du sous-équipement"
                      maxLength={120}
                      autoFocus
                    />
                    <input
                      className="lot-qty-input"
                      type="number"
                      min="1"
                      max="999"
                      value={draft.quantity}
                      onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
                      aria-label="Quantité"
                    />
                    <input
                      className="lot-note-input"
                      value={draft.notes}
                      onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                      aria-label="Précision"
                      placeholder="Précision (optionnel)"
                      maxLength={500}
                    />
                    <button type="submit" className="icon-btn icon-confirm" disabled={busy} title="Enregistrer">
                      <IconCheck size={18} />
                    </button>
                    <button type="button" className="icon-btn" onClick={() => setEditingId(null)} title="Annuler">
                      <IconClose size={18} />
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="lot-label">
                      <span className="lot-name">
                        {item.quantity > 1 && <span className="lot-qty">{item.quantity} ×</span>}
                        {item.name}
                      </span>
                      {item.notes && <span className="lot-note">{item.notes}</span>}
                    </span>
                    <span className="icon-group">
                      <button
                        className="icon-btn icon-edit"
                        onClick={() => startEdit(item)}
                        title={`Modifier ${item.name}`}
                        aria-label={`Modifier ${item.name}`}
                      >
                        <IconEdit size={16} />
                      </button>
                      <button
                        className="icon-btn icon-danger"
                        onClick={() => void remove(item.id)}
                        disabled={busy}
                        title={`Retirer ${item.name} du lot`}
                        aria-label={`Retirer ${item.name} du lot`}
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

        <form className="lot-form" onSubmit={add}>
          <input
            className="lot-name-input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            aria-label="Nom du sous-équipement à ajouter"
            placeholder="Remorque, godet, jerrican…"
            maxLength={120}
          />
          <input
            className="lot-qty-input"
            type="number"
            min="1"
            max="999"
            value={form.quantity}
            onChange={(e) => setForm({ ...form, quantity: e.target.value })}
            aria-label="Quantité à ajouter"
          />
          <input
            className="lot-note-input"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            aria-label="Précision à ajouter"
            placeholder="Précision (optionnel)"
            maxLength={500}
          />
          <button
            type="submit"
            className="icon-btn icon-primary"
            disabled={busy || form.name.trim().length === 0}
            title="Ajouter au lot"
            aria-label="Ajouter au lot"
          >
            <IconPlus size={20} />
          </button>
        </form>
      </div>
    </>
  );
}
