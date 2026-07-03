import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type {
  Balance,
  Equipment,
  Expense,
  ExpenseCategory,
  Member,
  Reimbursement,
  SettlementTransaction,
  SplitInput,
} from '../api';
import { CATEGORY_LABELS, formatDate, formatEuros } from '../format';

interface Props {
  members: Member[];
  currentMemberId: string;
}

type SplitType = 'EQUAL' | 'USAGE_PRORATED' | 'CUSTOM';

/** Dépenses, soldes et remboursements du cercle de l'équipement sélectionné. */
export function ExpensesPage({ members, currentMemberId }: Props) {
  const [equipments, setEquipments] = useState<Equipment[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [settlement, setSettlement] = useState<SettlementTransaction[]>([]);
  const [reimbursements, setReimbursements] = useState<Reimbursement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);

  const selected = equipments.find((e) => e.id === selectedId) ?? null;

  /** Membres du cercle de l'équipement sélectionné. */
  const circle = useMemo(
    () => (selected ? members.filter((m) => selected.memberIds.includes(m.id)) : []),
    [selected, members],
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

  const loadEquipments = useCallback(async () => {
    const list = await api.listEquipments();
    setEquipments(list);
    setSelectedId((id) => id || list.find((e) => e.memberIds.includes(currentMemberId))?.id || list[0]?.id || '');
  }, [currentMemberId]);

  const loadForEquipment = useCallback(async () => {
    if (!selectedId) return;
    const [xs, bs, plan, rbs] = await Promise.all([
      api.listExpenses(selectedId),
      api.balances(selectedId),
      api.settlement(selectedId),
      api.listReimbursements(selectedId),
    ]);
    setExpenses(xs);
    setBalances(bs);
    setSettlement(plan);
    setReimbursements(rbs);
  }, [selectedId]);

  useEffect(() => {
    loadEquipments().catch((e: Error) => setError(e.message));
  }, [loadEquipments]);

  useEffect(() => {
    loadForEquipment().catch((e: Error) => setError(e.message));
  }, [loadForEquipment]);

  // À chaque changement d'équipement (ou de son cercle), recale le formulaire.
  // Clé primitive : évite de relancer l'effet quand le rechargement recrée des objets identiques.
  const selectedMemberKey = selected ? selected.memberIds.join(',') : null;
  useEffect(() => {
    if (selectedMemberKey === null) return;
    const memberIds = selectedMemberKey === '' ? [] : selectedMemberKey.split(',');
    setForm((f) => ({
      ...f,
      payerId: memberIds.includes(f.payerId) ? f.payerId : (memberIds[0] ?? ''),
      equalMemberIds: memberIds,
      customAmounts: {},
    }));
  }, [selectedId, selectedMemberKey]);

  function memberName(id: string) {
    return members.find((m) => m.id === id)?.name ?? id;
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
    if (!selectedId) return;
    setError(null);
    setBusy(true);
    try {
      let receiptPath: string | null = null;
      if (form.receiptFile) {
        receiptPath = await api.uploadReceipt(form.receiptFile);
      }
      await api.addExpense({
        equipmentId: selectedId,
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
      await loadForEquipment();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur.');
    } finally {
      setBusy(false);
    }
  }

  async function markSettled(t: SettlementTransaction) {
    if (!selectedId) return;
    if (
      !confirm(
        `Confirmer : ${memberName(t.fromMemberId)} a remboursé ${formatEuros(t.amountEuros)} à ${memberName(t.toMemberId)} ?`,
      )
    )
      return;
    await api.recordReimbursement({
      equipmentId: selectedId,
      fromMemberId: t.fromMemberId,
      toMemberId: t.toMemberId,
      amountEuros: t.amountEuros,
      date: new Date().toISOString().slice(0, 10),
    });
    await loadForEquipment();
  }

  async function removeExpense(x: Expense) {
    if (!confirm(`Supprimer la dépense « ${x.label} » ?`)) return;
    await api.deleteExpense(x.id);
    await loadForEquipment();
  }

  if (equipments.length === 0) {
    return (
      <>
        {error && <div className="alert">{error}</div>}
        <p className="empty">Créez d'abord un équipement : les dépenses se partagent au sein de son cercle.</p>
      </>
    );
  }

  return (
    <>
      {error && <div className="alert">{error}</div>}

      <div className="card">
        <div className="row" style={{ alignItems: 'center' }}>
          <label className="field" style={{ flex: '0 0 auto', minWidth: '16rem' }}>
            Équipement
            <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
              {equipments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <p className="muted" style={{ margin: 0 }}>
              Cercle : {circle.map((m) => m.name).join(', ')} — chaque équipement a ses propres dépenses et soldes.
            </p>
          )}
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <h3>Soldes {selected ? `— ${selected.name}` : ''}</h3>
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

      {!showForm && (
        <button className="primary" onClick={() => setShowForm(true)} style={{ margin: '1rem 0' }}>
          + Ajouter une dépense
        </button>
      )}

      {showForm && selected && (
        <div className="card">
          <h3>Nouvelle dépense — {selected.name}</h3>
          <form className="stack" onSubmit={submit}>
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
                Les parts seront calculées à partir des heures réservées par chaque membre du cercle sur {selected.name}
                .
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

            <div className="row">
              <button className="primary" disabled={busy}>
                Enregistrer
              </button>
              <button type="button" className="ghost" onClick={() => setShowForm(false)}>
                Annuler
              </button>
            </div>
          </form>
        </div>
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
                {expenses.map((x) => (
                  <tr key={x.id}>
                    <td>{formatDate(x.date)}</td>
                    <td>
                      {x.label}
                      {x.receiptPath && (
                        <>
                          {' '}
                          <a href={x.receiptPath} target="_blank" rel="noreferrer">
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
                ))}
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
    </>
  );
}
