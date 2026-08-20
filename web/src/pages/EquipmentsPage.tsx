import { useCallback, useState } from 'react';
import { api } from '../api';
import type { DirectoryMember, Equipment, MaintenanceStatus, MeterUnit, SubEquipment } from '../api';
import { formatDate, formatEuros, meterLabel } from '../format';
import { errorMessage, useApiResource } from '../useApiResource';
import {
  IconCheck,
  IconChevron,
  IconClose,
  IconEdit,
  IconLogout,
  IconPlus,
  IconToolbox,
  IconTrash,
} from '../components/icons';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface Props {
  members: DirectoryMember[];
  currentMemberId: string;
  /** À rappeler quand un nouvel utilisateur est créé depuis cette page. */
  onMembersChanged: () => void;
}

const EMPTY_FORM = {
  name: '',
  category: '',
  acquisitionDate: new Date().toISOString().slice(0, 10),
  purchaseValueEuros: '',
  meterUnit: 'HOURS' as MeterUnit,
  memberIds: [] as string[],
  maintenanceThreshold: '',
};

export function EquipmentsPage({ members, currentMemberId, onMembersChanged }: Props) {
  const [editing, setEditing] = useState<Equipment | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [newMemberName, setNewMemberName] = useState('');
  const [invite, setInvite] = useState<{ memberName: string; url: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Equipment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<Equipment | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const resource = useApiResource(
    useCallback(async () => {
      const list = await api.listEquipments();
      // Le lot est chargé avec la liste : son décompte s'affiche sur la fiche repliée, et
      // l'ouvrir ne doit pas attendre un aller-retour de plus.
      const entries = await Promise.all(
        list.map(async (e) => [e.id, await api.maintenanceStatus(e.id), await api.listSubEquipments(e.id)] as const),
      );
      return {
        list,
        statuses: Object.fromEntries(entries.map(([id, status]) => [id, status])) as Record<string, MaintenanceStatus>,
        lots: Object.fromEntries(entries.map(([id, , lot]) => [id, lot])) as Record<string, SubEquipment[]>,
      };
    }, []),
  );

  const equipments = resource.data?.list ?? [];
  const statuses = resource.data?.statuses ?? {};
  const lots = resource.data?.lots ?? {};
  const error = actionError ?? resource.error;

  function startCreate() {
    setEditing(null);
    setForm({ ...EMPTY_FORM, memberIds: [currentMemberId] });
    setShowForm(true);
  }

  function startEdit(e: Equipment) {
    setEditing(e);
    setForm({
      name: e.name,
      category: e.category,
      acquisitionDate: e.acquisitionDate.slice(0, 10),
      purchaseValueEuros: String(e.purchaseValueEuros),
      meterUnit: e.meterUnit,
      memberIds: [...e.memberIds],
      maintenanceThreshold: e.maintenanceThreshold === null ? '' : String(e.maintenanceThreshold),
    });
    setShowForm(true);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setActionError(null);
    const payload = {
      name: form.name,
      category: form.category,
      acquisitionDate: form.acquisitionDate,
      purchaseValueEuros: Number(form.purchaseValueEuros || 0),
      meterUnit: form.meterUnit,
      memberIds: form.memberIds,
      maintenanceThreshold: form.maintenanceThreshold === '' ? null : Number(form.maintenanceThreshold),
    };
    try {
      if (editing) {
        await api.updateEquipment(editing.id, payload);
      } else {
        await api.createEquipment(payload);
      }
      setShowForm(false);
      await resource.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  function inviteUrl(code: string) {
    return `${window.location.origin}/invite/${code}`;
  }

  async function addMember() {
    const name = newMemberName.trim();
    if (!name) return;
    setActionError(null);
    try {
      const created = await api.createMember({ name });
      setNewMemberName('');
      // Le nouvel utilisateur rejoint le cercle en cours d'édition.
      setForm((f) => ({ ...f, memberIds: [...f.memberIds, created.id] }));
      setInvite({ memberName: created.name, url: inviteUrl(created.inviteCode) });
      onMembersChanged();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  async function shareInvite(member: DirectoryMember) {
    setActionError(null);
    try {
      const { inviteCode } = await api.regenerateInvite(member.id);
      setInvite({ memberName: member.name, url: inviteUrl(inviteCode) });
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  async function confirmRemove() {
    if (!pendingDelete) return;
    setActionError(null);
    setDeleting(true);
    try {
      await api.deleteEquipment(pendingDelete.id);
      await resource.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      // Fermée dans tous les cas : l'alerte d'erreur s'affiche en haut de page, sous la modale.
      setPendingDelete(null);
      setDeleting(false);
    }
  }

  async function confirmLeave() {
    if (!pendingLeave) return;
    setActionError(null);
    setLeaving(true);
    try {
      await api.leaveEquipment(pendingLeave.id);
      await resource.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setPendingLeave(null);
      setLeaving(false);
    }
  }

  function memberName(id: string) {
    return members.find((m) => m.id === id)?.name ?? id;
  }

  /** Comptes jamais ouverts : les seuls à qui un lien de première connexion peut encore servir. */
  const pendingMembers = members.filter((m) => !m.hasPassword);

  return (
    <>
      {error && <div className="alert">{error}</div>}

      {!showForm && (
        <button className="primary" onClick={startCreate} style={{ marginBottom: '1rem' }}>
          + Ajouter un équipement
        </button>
      )}

      {showForm && (
        <div className="card">
          <h3>{editing ? `Modifier ${editing.name}` : 'Nouvel équipement'}</h3>
          <form className="stack" onSubmit={submit}>
            <div className="row">
              <label className="field">
                Nom
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </label>
              <label className="field">
                Catégorie
                <input
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  placeholder="BTP, véhicule, jardin…"
                  required
                />
              </label>
            </div>
            <div className="row">
              <label className="field">
                Date d'acquisition
                <input
                  type="date"
                  value={form.acquisitionDate}
                  onChange={(e) => setForm({ ...form, acquisitionDate: e.target.value })}
                  required
                />
              </label>
              <label className="field">
                Valeur d'achat (€)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.purchaseValueEuros}
                  onChange={(e) => setForm({ ...form, purchaseValueEuros: e.target.value })}
                  required
                />
              </label>
            </div>
            <div className="row">
              <label className="field">
                Compteur
                <select
                  value={form.meterUnit}
                  onChange={(e) => setForm({ ...form, meterUnit: e.target.value as MeterUnit })}
                >
                  <option value="HOURS">Heures moteur</option>
                  <option value="KILOMETERS">Kilométrage</option>
                </select>
              </label>
              <label className="field">
                Seuil d'entretien ({meterLabel(form.meterUnit)} depuis la dernière maintenance)
                <input
                  type="number"
                  min="1"
                  value={form.maintenanceThreshold}
                  onChange={(e) => setForm({ ...form, maintenanceThreshold: e.target.value })}
                  placeholder="ex. 50 (vide = pas d'alerte)"
                />
              </label>
            </div>
            <span className="muted">Cercle de partage : qui utilise cet équipement ?</span>
            <div className="row">
              {members.map((m) => {
                // Le demandeur ne se retire jamais d'ici : à la création l'équipement lui serait
                // invisible, en modification le serveur l'exige (geste dédié « quitter le cercle »).
                const locked = m.id === currentMemberId;
                return (
                  <label key={m.id} className="check">
                    <input
                      type="checkbox"
                      checked={form.memberIds.includes(m.id)}
                      disabled={locked}
                      title={
                        locked
                          ? editing
                            ? 'Pour vous retirer, utilisez « Quitter le cercle » sur la fiche de l’équipement.'
                            : 'Vous faites partie du cercle des équipements que vous créez.'
                          : undefined
                      }
                      onChange={(e) =>
                        setForm({
                          ...form,
                          memberIds: e.target.checked
                            ? [...form.memberIds, m.id]
                            : form.memberIds.filter((id) => id !== m.id),
                        })
                      }
                    />
                    {m.name}
                  </label>
                );
              })}
            </div>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <label className="field">
                Ajouter une personne au cercle
                <input
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  placeholder="Prénom du nouvel utilisateur"
                />
              </label>
              <button type="button" className="ghost" onClick={() => void addMember()}>
                + Créer la personne
              </button>
            </div>
            {/* Une invitation pose un premier mot de passe, elle n'en réinitialise jamais un :
                pouvoir en émettre pour un compte ouvert reviendrait à pouvoir en prendre le
                contrôle. Les comptes déjà ouverts sont donc absents de cette liste. */}
            {pendingMembers.length > 0 && (
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <label className="field">
                  Lien de première connexion (personnes n'ayant pas encore choisi leur mot de passe)
                  <select
                    value=""
                    onChange={(e) => {
                      const m = pendingMembers.find((x) => x.id === e.target.value);
                      if (m) void shareInvite(m);
                    }}
                  >
                    <option value="" disabled>
                      Choisir une personne…
                    </option>
                    {pendingMembers.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {invite && (
              <div className="card" style={{ background: 'transparent' }}>
                <p className="muted">
                  Transmettez ce lien à <strong>{invite.memberName}</strong> (WhatsApp, SMS…) pour qu'il choisisse son
                  mot de passe. Il est valable 7 jours :
                </p>
                <div className="row">
                  <input readOnly value={invite.url} onFocus={(e) => e.target.select()} style={{ flex: 1 }} />
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void navigator.clipboard.writeText(invite.url)}
                  >
                    Copier
                  </button>
                </div>
              </div>
            )}
            <div className="row">
              <button className="primary">{editing ? 'Enregistrer' : 'Créer'}</button>
              <button type="button" className="ghost" onClick={() => setShowForm(false)}>
                Annuler
              </button>
            </div>
          </form>
        </div>
      )}

      {equipments.length === 0 && !showForm && (
        <p className="empty">Aucun équipement partagé avec vous. Ajoutez votre minipelle, utilitaire, bétonnière…</p>
      )}

      <div className="grid">
        {equipments.map((e) => {
          const status = statuses[e.id];
          return (
            <div className="card" key={e.id}>
              <h3>{e.name}</h3>
              <p className="muted">
                {e.category} · acquis le {formatDate(e.acquisitionDate)} · {formatEuros(e.purchaseValueEuros)}
              </p>
              <p>
                {status?.alert ? (
                  <span className="badge danger">
                    🔧 Entretien requis ({status.unitsSinceMaintenance} {meterLabel(e.meterUnit)} depuis la dernière
                    maintenance)
                  </span>
                ) : status?.currentReading !== null && status?.currentReading !== undefined ? (
                  <span className="badge">
                    Compteur : {status.currentReading} {meterLabel(e.meterUnit)}
                  </span>
                ) : (
                  <span className="badge warn">Aucun relevé</span>
                )}
              </p>
              <p className="muted">Cercle : {e.memberIds.map(memberName).join(', ')}</p>
              <div className="icon-group" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  className="icon-btn icon-edit"
                  onClick={() => startEdit(e)}
                  title="Modifier"
                  aria-label="Modifier"
                >
                  <IconEdit size={20} />
                </button>
                {/* Le dernier membre n'a rien à quitter : l'équipement deviendrait invisible
                    pour tout le monde, le serveur le refuse. Il lui reste la suppression. */}
                {e.memberIds.length > 1 && (
                  <button
                    className="icon-btn"
                    onClick={() => setPendingLeave(e)}
                    title="Quitter le cercle"
                    aria-label="Quitter le cercle"
                  >
                    <IconLogout size={20} />
                  </button>
                )}
                <button
                  className="icon-btn icon-danger"
                  onClick={() => setPendingDelete(e)}
                  title="Supprimer"
                  aria-label="Supprimer"
                >
                  <IconTrash size={20} />
                </button>
              </div>
              {/* Après les gestes de la fiche : le lot se déplie sous elle, et les icônes de ses
                  éléments ne se confondent pas avec celles de l'équipement. */}
              <SubEquipmentSection
                equipment={e}
                items={lots[e.id] ?? []}
                onChanged={resource.reload}
                onError={setActionError}
              />
            </div>
          );
        })}
      </div>

      {pendingLeave && (
        <ConfirmDialog
          title={`Quitter le cercle de « ${pendingLeave.name} » ?`}
          confirmLabel="Quitter le cercle"
          busy={leaving}
          onConfirm={() => void confirmLeave()}
          onCancel={() => setPendingLeave(null)}
        >
          <p style={{ margin: 0 }}>L'équipement disparaîtra de votre application, avec tout ce que vous en voyez :</p>
          <ul className="modal-loss">
            <li>ses réservations, ses relevés et son suivi d'entretien</li>
            <li>ses dépenses, justificatifs, remboursements et votre solde</li>
            <li>ses fils de discussion et ses checklists</li>
          </ul>
          <p className="muted" style={{ margin: 0 }}>
            Rien n'est supprimé pour les {pendingLeave.memberIds.length - 1} autres membres, qui sont prévenus de votre
            départ. Seul l'un d'eux pourra vous réintégrer au cercle.
          </p>
        </ConfirmDialog>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Supprimer « ${pendingDelete.name} » ?`}
          confirmLabel="Supprimer définitivement"
          busy={deleting}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setPendingDelete(null)}
        >
          <p style={{ margin: 0 }}>
            L'équipement disparaîtra pour les {pendingDelete.memberIds.length} membres de son cercle, avec tout son
            historique :
          </p>
          <ul className="modal-loss">
            <li>ses réservations, passées comme à venir</li>
            <li>ses relevés de compteur et son suivi d'entretien</li>
            <li>ses dépenses, justificatifs, remboursements et soldes</li>
            <li>ses fils de discussion et tous leurs messages</li>
            <li>ses checklists et tous leurs points</li>
          </ul>
          <p className="muted" style={{ margin: 0 }}>
            Cette suppression est définitive : rien de tout cela ne pourra être restauré.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

interface SubEquipmentSectionProps {
  equipment: Equipment;
  items: SubEquipment[];
  /** Relit la liste des équipements et leurs lots après une écriture. */
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}

const EMPTY_SUB_FORM = { name: '', quantity: '1', notes: '' };

/**
 * Contenu du lot d'un équipement : ce qui part avec lui — la remorque de la minipelle, ses godets,
 * sa pompe à graisse, un jerrican. C'est un inventaire, pas un équipement en réduction : rien ici
 * ne se réserve ni ne porte de dépense, tout cela reste au niveau de l'équipement.
 *
 * Le lot appartient au cercle : tout membre le complète, le corrige et le retire, quel qu'ait été
 * l'auteur de la saisie (le serveur applique la même règle).
 */
function SubEquipmentSection({ equipment, items, onChanged, onError }: SubEquipmentSectionProps) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_SUB_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState(EMPTY_SUB_FORM);
  const [busy, setBusy] = useState(false);

  /** Écriture suivie d'une relecture ; l'échec s'affiche dans le bandeau de la page. */
  async function run(action: () => Promise<void>) {
    setBusy(true);
    onError(null);
    try {
      await action();
      await onChanged();
    } catch (e) {
      onError(errorMessage(e));
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
      setForm(EMPTY_SUB_FORM);
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

  // Retiré sans confirmation : la ligne se resaisit en deux secondes. Les modales de cette page
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
    <div className="lot">
      <button
        type="button"
        className="lot-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={open ? 'Masquer le contenu du lot' : 'Voir le contenu du lot'}
      >
        <IconChevron size={16} open={open} />
        <IconToolbox size={16} />
        Contenu du lot{items.length > 0 && <span className="lot-count">{items.length}</span>}
      </button>

      {open && (
        <>
          {items.length === 0 ? (
            <p className="muted lot-empty">
              Rien pour l'instant : ajoutez ce qui part avec l'équipement — remorque, godets, pompe à graisse, caisse à
              outils, jerrican…
            </p>
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
        </>
      )}
    </div>
  );
}
