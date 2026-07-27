import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Equipment, MaintenanceStatus, Member, MeterUnit } from '../api';
import { formatDate, formatEuros, meterLabel } from '../format';
import { IconEdit, IconTrash } from '../components/icons';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface Props {
  members: Member[];
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
  const [equipments, setEquipments] = useState<Equipment[]>([]);
  const [statuses, setStatuses] = useState<Record<string, MaintenanceStatus>>({});
  const [editing, setEditing] = useState<Equipment | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [newMemberName, setNewMemberName] = useState('');
  const [invite, setInvite] = useState<{ memberName: string; url: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Equipment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = await api.listEquipments();
    setEquipments(list);
    const entries = await Promise.all(list.map(async (e) => [e.id, await api.maintenanceStatus(e.id)] as const));
    setStatuses(Object.fromEntries(entries));
  }, []);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

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
    setError(null);
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
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur.');
    }
  }

  function inviteUrl(code: string) {
    return `${window.location.origin}/invite/${code}`;
  }

  async function addMember() {
    const name = newMemberName.trim();
    if (!name) return;
    setError(null);
    try {
      const created = await api.createMember({ name });
      setNewMemberName('');
      // Le nouvel utilisateur rejoint le cercle en cours d'édition.
      setForm((f) => ({ ...f, memberIds: [...f.memberIds, created.id] }));
      setInvite({ memberName: created.name, url: inviteUrl(created.inviteCode) });
      onMembersChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur.');
    }
  }

  async function shareInvite(member: Member) {
    setError(null);
    try {
      const { inviteCode } = await api.regenerateInvite(member.id);
      setInvite({ memberName: member.name, url: inviteUrl(inviteCode) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur.');
    }
  }

  async function confirmRemove() {
    if (!pendingDelete) return;
    setError(null);
    setDeleting(true);
    try {
      await api.deleteEquipment(pendingDelete.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur.');
    } finally {
      // Fermée dans tous les cas : l'alerte d'erreur s'affiche en haut de page, sous la modale.
      setPendingDelete(null);
      setDeleting(false);
    }
  }

  function memberName(id: string) {
    return members.find((m) => m.id === id)?.name ?? id;
  }

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
                // À la création, le créateur reste dans le cercle : sinon l'équipement lui serait invisible.
                const locked = !editing && m.id === currentMemberId;
                return (
                  <label key={m.id} className="check">
                    <input
                      type="checkbox"
                      checked={form.memberIds.includes(m.id)}
                      disabled={locked}
                      title={locked ? 'Vous faites partie du cercle des équipements que vous créez.' : undefined}
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
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <label className="field">
                Lien d'invitation (premier accès ou mot de passe perdu)
                <select
                  value=""
                  onChange={(e) => {
                    const m = members.find((x) => x.id === e.target.value);
                    if (m) void shareInvite(m);
                  }}
                >
                  <option value="" disabled>
                    Choisir une personne…
                  </option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {invite && (
              <div className="card" style={{ background: 'transparent' }}>
                <p className="muted">
                  Transmettez ce lien à <strong>{invite.memberName}</strong> (WhatsApp, SMS…) pour qu'il choisisse son
                  mot de passe :
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
                <button
                  className="icon-btn icon-danger"
                  onClick={() => setPendingDelete(e)}
                  title="Supprimer"
                  aria-label="Supprimer"
                >
                  <IconTrash size={20} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

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
