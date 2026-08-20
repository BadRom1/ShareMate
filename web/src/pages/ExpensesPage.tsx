import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, receiptUrl } from '../api';
import type { Equipment, Expense, ExpenseCategory, Member, SettlementTransaction, SplitInput } from '../api';
import { CATEGORY_LABELS, formatDate, formatEuros } from '../format';
import { errorMessage, firstError, useApiResource } from '../useApiResource';
import { Modal } from '../components/Modal';
import { Fab } from '../components/Fab';

interface Props {
  members: Member[];
  currentMemberId: string;
  /** Équipement de l'espace de travail courant, choisi dans la coque de l'application. */
  equipment: Equipment;
}

type SplitType = 'EQUAL' | 'USAGE_PRORATED' | 'CUSTOM';

/** Dépenses, soldes et remboursements du cercle de l'équipement courant. */
export function ExpensesPage({ members, currentMemberId, equipment }: Props) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);

  /** Dépenses, soldes, plan de remboursement et remboursements de l'équipement courant. */
  const accountsResource = useApiResource(
    useCallback(async () => {
      const [expenses, balances, settlement, reimbursements] = await Promise.all([
        api.listExpenses(equipment.id),
        api.balances(equipment.id),
        api.settlement(equipment.id),
        api.listReimbursements(equipment.id),
      ]);
      return { expenses, balances, settlement, reimbursements };
    }, [equipment.id]),
  );

  const expenses = accountsResource.data?.expenses ?? [];
  const balances = accountsResource.data?.balances ?? [];
  const settlement = accountsResource.data?.settlement ?? [];
  const reimbursements = accountsResource.data?.reimbursements ?? [];
  // L'échec d'un chargement appartient à la page ; l'échec d'un enregistrement appartient à la
  // modale, qui recouvre la page — un message affiché derrière elle ne serait pas lisible.
  const pageError = firstError(accountsResource);

  /** Membres du cercle de l'équipement courant. */
  const circle = useMemo(
    () => members.filter((m) => equipment.memberIds.includes(m.id)),
    [equipment.memberIds, members],
  );

  const [form, setForm] = useState({
    label: '',
    amountEuros: '',
    payerId: currentMemberId,
    date: new Date().toISOString().slice(0, 10),
    category: 'FUEL' as ExpenseCategory,
    splitType: 'EQUAL' as SplitType,
    equalMemberIds: [] as string[],
    customAmounts: {} as Record<string, string>,
    receiptFile: null as File | null,
  });

  // À chaque changement d'équipement (ou de son cercle), recale le formulaire.
  // Clé primitive : évite de relancer l'effet quand le rechargement recrée des objets identiques.
  const circleKey = equipment.memberIds.join(',');
  useEffect(() => {
    const memberIds = circleKey === '' ? [] : circleKey.split(',');
    setForm((f) => ({
      ...f,
      payerId: memberIds.includes(f.payerId) ? f.payerId : (memberIds[0] ?? ''),
      equalMemberIds: memberIds,
      customAmounts: {},
    }));
  }, [circleKey]);

  function memberName(id: string) {
    return members.find((m) => m.id === id)?.name ?? id;
  }

  function closeForm() {
    // Le refus du serveur est attaché à la tentative qu'on abandonne : il ne doit pas
    // accueillir la prochaine ouverture.
    setActionError(null);
    setShowForm(false);
  }

  function buildSplit(): SplitInput {
    if (form.splitType === 'EQUAL') return { type: 'EQUAL', memberIds: form.equalMemberIds };
    if (form.splitType === 'USAGE_PRORATED') return { type: 'USAGE_PRORATED' };
    return {
      type: 'CUSTOM',
      amountsEuros: Object.fromEntries(
        Object.entries(form.customAmounts)
          .filter(([, v]) => v !== '' && Number(v) > 0)
          .map(([k, v]) => [k, Number(v)]),
      ),
    };
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setActionError(null);
    setBusy(true);
    try {
      let receiptPath: string | null = null;
      if (form.receiptFile) {
        receiptPath = await api.uploadReceipt(form.receiptFile);
      }
      await api.addExpense({
        equipmentId: equipment.id,
        label: form.label,
        amountEuros: Number(form.amountEuros),
        payerId: form.payerId,
        date: form.date,
        category: form.category,
        split: buildSplit(),
        receiptPath,
      });
      setShowForm(false);
      setForm({
        ...form,
        label: '',
        amountEuros: '',
        customAmounts: {},
        receiptFile: null,
      });
      await accountsResource.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function markSettled(t: SettlementTransaction) {
    if (
      !confirm(
        `Confirmer : ${memberName(t.fromMemberId)} a remboursé ${formatEuros(t.amountEuros)} à ${memberName(t.toMemberId)} ?`,
      )
    )
      return;
    await api.recordReimbursement({
      equipmentId: equipment.id,
      fromMemberId: t.fromMemberId,
      toMemberId: t.toMemberId,
      amountEuros: t.amountEuros,
      date: new Date().toISOString().slice(0, 10),
    });
    await accountsResource.reload();
  }

  async function removeExpense(x: Expense) {
    if (!confirm(`Supprimer la dépense « ${x.label} » ?`)) return;
    await api.deleteExpense(x.id);
    await accountsResource.reload();
  }

  return (
    <>
      {pageError && <div className="alert">{pageError}</div>}

      <div className="grid">
        <div className="card">
          <h3>Soldes — {equipment.name}</h3>
          <table>
            <tbody>
              {balances.map((b) => (
                <tr key={b.memberId}>
                  <td>{memberName(b.memberId)}</td>
                  <td className={b.balanceEuros > 0 ? 'amount-pos' : b.balanceEuros < 0 ? 'amount-neg' : ''}>
                    {b.balanceEuros > 0 ? '+' : ''}
                    {formatEuros(b.balanceEuros)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Positif = le cercle lui doit de l'argent.</p>
        </div>

        <div className="card">
          <h3>Qui rembourse qui ?</h3>
          {settlement.length === 0 ? (
            <p className="muted">✅ Tout le monde est à jour.</p>
          ) : (
            settlement.map((t, i) => (
              <div className="reservation-item" key={i}>
                <span>
                  <strong>{memberName(t.fromMemberId)}</strong> doit {formatEuros(t.amountEuros)} à{' '}
                  <strong>{memberName(t.toMemberId)}</strong>
                </span>
                <button className="ghost" style={{ marginLeft: 'auto' }} onClick={() => void markSettled(t)}>
                  Marquer remboursé
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {showForm && (
        <Modal title={`Nouvelle dépense — ${equipment.name}`} onClose={closeForm}>
          {actionError && <div className="alert">{actionError}</div>}
          <form className="modal-form" onSubmit={submit}>
            <div className="row">
              <label className="field">
                Libellé
                <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} required />
              </label>
              <label className="field">
                Montant (€)
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={form.amountEuros}
                  onChange={(e) => setForm({ ...form, amountEuros: e.target.value })}
                  required
                />
              </label>
            </div>
            <div className="row">
              <label className="field">
                Payé par
                <select value={form.payerId} onChange={(e) => setForm({ ...form, payerId: e.target.value })}>
                  {circle.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Date
                <input
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm({ ...form, date: e.target.value })}
                  required
                />
              </label>
              <label className="field">
                Catégorie
                <select
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value as ExpenseCategory })}
                >
                  {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="field">
              Répartition (au sein du cercle)
              <select
                value={form.splitType}
                onChange={(e) => setForm({ ...form, splitType: e.target.value as SplitType })}
              >
                <option value="EQUAL">Parts égales</option>
                <option value="USAGE_PRORATED">Au prorata du temps d'usage (réservations)</option>
                <option value="CUSTOM">Montants personnalisés</option>
              </select>
            </label>

            {form.splitType === 'EQUAL' && (
              <div className="row">
                {circle.map((m) => (
                  <label key={m.id} className="check">
                    <input
                      type="checkbox"
                      checked={form.equalMemberIds.includes(m.id)}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          equalMemberIds: e.target.checked
                            ? [...form.equalMemberIds, m.id]
                            : form.equalMemberIds.filter((id) => id !== m.id),
                        })
                      }
                    />
                    {m.name}
                  </label>
                ))}
              </div>
            )}

            {form.splitType === 'USAGE_PRORATED' && (
              <p className="muted">
                Les parts seront calculées à partir des heures réservées par chaque membre du cercle sur{' '}
                {equipment.name}.
              </p>
            )}

            {form.splitType === 'CUSTOM' && (
              <div className="row">
                {circle.map((m) => (
                  <label key={m.id} className="field">
                    {m.name} (€)
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={form.customAmounts[m.id] ?? ''}
                      onChange={(e) =>
                        setForm({ ...form, customAmounts: { ...form.customAmounts, [m.id]: e.target.value } })
                      }
                    />
                  </label>
                ))}
              </div>
            )}

            <label className="field">
              Justificatif (image ou PDF, optionnel)
              <input
                type="file"
                accept=".png,.jpg,.jpeg,.webp,.pdf"
                onChange={(e) => setForm({ ...form, receiptFile: e.target.files?.[0] ?? null })}
              />
            </label>

            <div className="modal-actions">
              <button type="button" className="ghost" onClick={closeForm}>
                Annuler
              </button>
              <button className="primary" disabled={busy}>
                Enregistrer
              </button>
            </div>
          </form>
        </Modal>
      )}

      <div className="card">
        <h3>Dépenses</h3>
        {expenses.length === 0 ? (
          <p className="empty">Aucune dépense pour cet équipement.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Libellé</th>
                  <th>Catégorie</th>
                  <th>Montant</th>
                  <th>Payé par</th>
                  <th>Répartition</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {expenses.map((x) => {
                  // Lien ouvert seulement si le chemin est bien celui d'un fichier téléversé ici.
                  const receipt = receiptUrl(x.receiptPath);
                  return (
                    <tr key={x.id}>
                      <td>{formatDate(x.date)}</td>
                      <td>
                        {x.label}
                        {receipt && (
                          <>
                            {' '}
                            <a href={receipt} target="_blank" rel="noreferrer">
                              📎
                            </a>
                          </>
                        )}
                      </td>
                      <td>{CATEGORY_LABELS[x.category]}</td>
                      <td>{formatEuros(x.amountEuros)}</td>
                      <td>{memberName(x.payerId)}</td>
                      <td className="muted">
                        {Object.entries(x.sharesEuros)
                          .map(([id, euros]) => `${memberName(id)} ${formatEuros(euros)}`)
                          .join(' · ')}
                      </td>
                      <td>
                        <button className="danger" onClick={() => void removeExpense(x)}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Remboursements effectués</h3>
        {reimbursements.length === 0 ? (
          <p className="empty">Aucun remboursement déclaré.</p>
        ) : (
          <table>
            <tbody>
              {reimbursements.map((r) => (
                <tr key={r.id}>
                  <td>{formatDate(r.date)}</td>
                  <td>
                    {memberName(r.fromMemberId)} → {memberName(r.toMemberId)}
                  </td>
                  <td>{formatEuros(r.amountEuros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Fab label="Ajouter une dépense" onClick={() => setShowForm(true)} />
    </>
  );
}
