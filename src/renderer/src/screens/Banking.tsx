import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ChequeConfig } from '@shared/schemas'
import { api, type BankRuleRecord, type BankSuggestionRow } from '../lib/client'
import { useNav, useSession, useToasts, nextDraftId } from '../state/stores'
import { Button, EmptyState, Field, Modal, Money, Panel, SectionTitle, Select, TextInput, inputCls } from '../components/ui'
import { LedgerPicker } from '../components/pickers'
import { parseSmartDate, toDisplayDate, todayISO } from '@shared/dates'
import { suggestPattern } from '@shared/bankRules'
import { confirmDialog, promptDialog } from '../lib/dialogs'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'

export function BankingScreen(): React.JSX.Element {
  const nav = useNav()
  const { from, to } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: ledgers } = useQuery({ queryKey: ['bankLedgers'], queryFn: api.bank.ledgers })
  const [ledgerId, setLedgerId] = useState<number | null>(null)
  const [suggestions, setSuggestions] = useState<BankSuggestionRow[] | null>(null)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [rulesPrefill, setRulesPrefill] = useState<{ pattern: string; kind: 'payment' | 'receipt' } | null>(null)
  const [rulesModalKey, setRulesModalKey] = useState(0)
  const [chequeSetupOpen, setChequeSetupOpen] = useState(false)

  useEffect(() => {
    if (ledgerId == null && ledgers?.length) setLedgerId(ledgers[0]!.id)
  }, [ledgers, ledgerId])

  // A new bank ledger's statement lines have nothing to do with the last one's suggestions.
  useEffect(() => {
    setSuggestions(null)
  }, [ledgerId])

  const { data: recon } = useQuery({
    queryKey: ['bankRecon', ledgerId, from, to],
    queryFn: () => api.bank.recon(ledgerId!, from, to),
    enabled: ledgerId != null
  })

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ['bankRecon'] }).then(() => undefined)

  const markToday = async (lineId: number, current: string | null): Promise<void> => {
    try {
      await api.bank.setBankDate(lineId, current ? null : todayISO())
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const editBankDate = async (lineId: number, current: string | null): Promise<void> => {
    const answer = await promptDialog({
      title: 'Bank date',
      message: 'When did this clear at the bank? e.g. 15-08-2026, or 7, 7/4, t, y. Empty clears it.',
      initial: current ? toDisplayDate(current) : '',
      confirmLabel: 'Set date'
    })
    if (answer === null) return
    try {
      if (answer.trim() === '') {
        await api.bank.setBankDate(lineId, null)
      } else {
        const parsed = parseSmartDate(answer, todayISO())
        if (!parsed) return void toast.push('error', 'That date didn’t parse')
        await api.bank.setBankDate(lineId, parsed)
      }
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const doImport = async (): Promise<void> => {
    if (ledgerId == null) return
    let result
    try {
      result = await api.bank.importCsv(ledgerId)
    } catch (err) {
      toast.push('error', (err as Error).message)
      return
    }
    if (!result) return
    toast.push(
      result.matched > 0 ? 'success' : 'warning',
      `${result.matched} of ${result.statementRows} statement rows matched and reconciled${result.unmatched.length ? `; ${result.unmatched.length} unmatched` : ''}`
    )
    await refresh()

    if (result.unmatched.length === 0) {
      setSuggestions(null)
      return
    }
    try {
      const rows = await api.bank.suggest(ledgerId, result.csvText)
      setSuggestions(rows)
      const withSuggestion = rows.filter((r) => r.suggestion).length
      if (withSuggestion > 0) toast.push('info', `${withSuggestion} of ${rows.length} unmatched lines have a suggested ledger below`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const createFromSuggestion = async (row: BankSuggestionRow): Promise<void> => {
    if (row.suggestion) {
      try {
        await api.bankRules.hit(row.suggestion.ruleId)
      } catch {
        // Non-fatal — the draft is still worth opening even if the hit counter didn't update.
      }
      nav.go({ name: 'voucher-entry', kindHint: row.suggestion.kind, draft: row.suggestion.voucherDraft, draftId: nextDraftId() })
      return
    }
    if (ledgerId == null) return
    const isDeposit = row.statementRow.kind === 'deposit'
    nav.go({
      name: 'voucher-entry',
      kindHint: isDeposit ? 'receipt' : 'payment',
      draft: {
        date: row.statementRow.date,
        narration: row.statementRow.description,
        lines: [{ ledgerId, drCr: isDeposit ? 'dr' : 'cr', amount: row.statementRow.amount }]
      },
      draftId: nextDraftId()
    })
  }

  const openRules = (prefill: { pattern: string; kind: 'payment' | 'receipt' } | null): void => {
    setRulesPrefill(prefill)
    setRulesModalKey((k) => k + 1)
    setRulesOpen(true)
  }

  const rememberRule = (row: BankSuggestionRow): void => {
    const kind: 'payment' | 'receipt' = row.statementRow.kind === 'deposit' ? 'receipt' : 'payment'
    openRules({ pattern: suggestPattern(row.statementRow.description), kind })
  }

  if (ledgers && ledgers.length === 0) {
    return (
      <div className="mx-auto max-w-4xl">
        <SectionTitle>Bank reconciliation</SectionTitle>
        <Panel>
          <EmptyState title="No bank ledgers yet" hint="Create a ledger under Bank Accounts in Masters, then reconcile it here" />
        </Panel>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <Select value={ledgerId ?? ''} onChange={(e) => setLedgerId(Number(e.target.value))} className="w-52">
              {(ledgers ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
            <Button onClick={() => openRules(null)}>Rules…</Button>
            {ledgerId != null && <Button onClick={() => setChequeSetupOpen(true)}>Cheque setup…</Button>}
            <Button variant="primary" data-testid="btn-banking-import" onClick={() => void doImport()}>
              Import statement CSV
            </Button>
          </div>
        }
      >
        Bank reconciliation
      </SectionTitle>

      {recon && (
        <>
          <div className="mb-3 grid grid-cols-4 gap-3">
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">Balance as per books</p>
              <p className="num mt-1 text-[15px] font-medium"><Money paise={recon.bookBalance} /></p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">Deposits not in bank</p>
              <p className="num mt-1 text-[15px] font-medium"><Money paise={recon.unreconciledDeposits} /></p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">Withdrawals not in bank</p>
              <p className="num mt-1 text-[15px] font-medium"><Money paise={recon.unreconciledWithdrawals} /></p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">Balance as per bank</p>
              <p className="num mt-1 text-[15px] font-medium"><Money paise={recon.bankBalance} /></p>
            </Panel>
          </div>

          <Panel>
            {recon.rows.length === 0 ? (
              <EmptyState title="No bank entries in this period" />
            ) : (
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th className="w-24">Date</th>
                    <th>Particulars</th>
                    <th className="w-28">Instrument</th>
                    <th className="r w-32">Deposit</th>
                    <th className="r w-32">Withdrawal</th>
                    <th className="w-32">Bank date</th>
                    <th className="w-24"></th>
                  </tr>
                </thead>
                <tbody data-testid="rows-banking">
                  {recon.rows.map((r) => (
                    <tr key={r.lineId} className={r.bankDate ? 'opacity-60' : ''}>
                      <td className="num text-muted">{toDisplayDate(r.date)}</td>
                      <td className="max-w-56 truncate">{r.particulars}</td>
                      <td className="num text-muted">{r.instrumentNo ?? ''}</td>
                      <td className="r"><Money paise={r.deposit} /></td>
                      <td className="r"><Money paise={r.withdrawal} /></td>
                      <td>
                        <button className="num text-[12px] text-blue hover:underline" onClick={() => void editBankDate(r.lineId, r.bankDate)}>
                          {r.bankDate ? toDisplayDate(r.bankDate) : 'Set date'}
                        </button>
                      </td>
                      <td className="r">
                        <button className="text-[12px] text-muted hover:text-ink" onClick={() => void markToday(r.lineId, r.bankDate)}>
                          {r.bankDate ? 'Clear' : 'Cleared today'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          <p className="mt-2 text-[11.5px] text-muted">
            Import a statement CSV (date + debit/credit columns) to auto-match by amount and date; anything left over, set the bank date by hand.
          </p>

          {suggestions && suggestions.length > 0 && (
            <Panel className="mt-3">
              <div className="border-b border-line px-4 py-2.5">
                <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">Unmatched statement lines</p>
              </div>
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th className="w-24">Date</th>
                    <th>Description</th>
                    <th className="r w-32">Amount</th>
                    <th className="w-48">Suggested ledger</th>
                    <th className="w-56"></th>
                  </tr>
                </thead>
                <tbody>
                  {suggestions.map((s, i) => (
                    <tr key={i} className="hover:bg-panel2">
                      <td className="num text-muted">{toDisplayDate(s.statementRow.date)}</td>
                      <td className="max-w-72 truncate">{s.statementRow.description}</td>
                      <td className="r"><Money paise={s.statementRow.amount} /></td>
                      <td>
                        {s.suggestion ? (
                          <span className="rounded px-1.5 py-0.5 text-[10.5px] bg-blue/10 text-blue">{s.suggestion.ledgerName}</span>
                        ) : (
                          <span className="text-[11.5px] text-muted">No match</span>
                        )}
                      </td>
                      <td className="r">
                        <button className="mr-3 text-[12px] text-blue hover:underline" onClick={() => void createFromSuggestion(s)}>
                          Create voucher
                        </button>
                        <button className="text-[12px] text-muted hover:text-ink" onClick={() => rememberRule(s)}>
                          Remember as rule
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
        </>
      )}

      {rulesOpen && (
        <BankRulesModal key={rulesModalKey} prefill={rulesPrefill} onClose={() => setRulesOpen(false)} />
      )}
      {chequeSetupOpen && ledgerId != null && (
        <ChequeSetupModal
          bankLedgerId={ledgerId}
          bankLedgerName={(ledgers ?? []).find((l) => l.id === ledgerId)?.name ?? ''}
          onClose={() => setChequeSetupOpen(false)}
        />
      )}
    </div>
  )
}

function BankRulesModal({
  onClose,
  prefill
}: {
  onClose: () => void
  prefill: { pattern: string; kind: 'payment' | 'receipt' } | null
}): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: rules } = useQuery({ queryKey: ['bankRules'], queryFn: api.bankRules.list })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [pattern, setPattern] = useState(prefill?.pattern ?? '')
  const [ledgerId, setLedgerId] = useState<number | null>(null)
  const [kind, setKind] = useState<'payment' | 'receipt'>(prefill?.kind ?? 'payment')
  const [active, setActive] = useState(true)
  const [saving, setSaving] = useState(false)

  const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ['bankRules'] }).then(() => undefined)

  const resetForm = (): void => {
    setEditingId(null)
    setPattern('')
    setLedgerId(null)
    setKind('payment')
    setActive(true)
  }

  const edit = (r: BankRuleRecord): void => {
    setEditingId(r.id)
    setPattern(r.pattern)
    setLedgerId(r.ledgerId)
    setKind(r.kind)
    setActive(r.active)
  }

  const save = async (): Promise<void> => {
    if (pattern.trim().length < 2) return void toast.push('error', 'Pattern needs at least 2 characters')
    if (ledgerId == null) return void toast.push('error', 'Pick a ledger')
    setSaving(true)
    try {
      await api.bankRules.save({ pattern: pattern.trim(), ledgerId, kind, active }, editingId ?? undefined)
      await invalidate()
      toast.push('success', editingId ? 'Rule updated' : 'Rule created')
      resetForm()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (r: BankRuleRecord): Promise<void> => {
    const proceed = await confirmDialog({
      title: 'Delete rule',
      message: `Delete rule "${r.pattern}"?`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!proceed) return
    try {
      await api.bankRules.remove(r.id)
      await invalidate()
      if (editingId === r.id) resetForm()
      toast.push('success', 'Rule deleted')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const toggleActive = async (r: BankRuleRecord): Promise<void> => {
    try {
      await api.bankRules.save({ pattern: r.pattern, ledgerId: r.ledgerId, kind: r.kind, active: !r.active }, r.id)
      await invalidate()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="Bank rules" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        {!rules?.length ? (
          <EmptyState title="No bank rules yet" hint={'Add one below, or use "Remember as rule" on an unmatched statement line'} />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Pattern</th>
                <th>Ledger</th>
                <th className="w-24">Kind</th>
                <th className="r w-16">Hits</th>
                <th className="w-16">Active</th>
                <th className="w-32"></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="hover:bg-panel2">
                  <td>{r.pattern}</td>
                  <td className="text-muted">{r.ledgerName}</td>
                  <td className="capitalize">{r.kind}</td>
                  <td className="num r">{r.hits}</td>
                  <td>
                    <button className="text-[12px] text-blue hover:underline" onClick={() => void toggleActive(r)}>
                      {r.active ? 'Active' : 'Paused'}
                    </button>
                  </td>
                  <td className="r">
                    <button className="mr-3 text-[12px] text-blue hover:underline" onClick={() => edit(r)}>
                      Edit
                    </button>
                    <button className="text-[12px] text-cr hover:underline" onClick={() => void remove(r)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="border-t border-line pt-4">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{editingId ? 'Edit rule' : 'Add rule'}</p>
          <div className="grid grid-cols-4 gap-3">
            <Field label="Pattern">
              <TextInput autoFocus value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="e.g. ACME SUPPLIES" />
            </Field>
            <Field label="Ledger">
              <LedgerPicker value={ledgerId} onPick={setLedgerId} placeholder="Ledger" />
            </Field>
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value as 'payment' | 'receipt')}>
                <option value="payment">Payment (withdrawal)</option>
                <option value="receipt">Receipt (deposit)</option>
              </Select>
            </Field>
            <div className="flex items-end pb-1.5">
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                Active
              </label>
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            {editingId && <Button onClick={resetForm}>Cancel edit</Button>}
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {editingId ? 'Save changes' : 'Add rule'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** mm-offset number field — plain <input type="number"> (no rupee/date parsing needed here). */
function MmField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }): React.JSX.Element {
  return (
    <Field label={label}>
      <input
        type="number"
        step="0.5"
        className={`${inputCls} num text-right`}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </Field>
  )
}

function ChequeSetupModal({
  bankLedgerId,
  bankLedgerName,
  onClose
}: {
  bankLedgerId: number
  bankLedgerName: string
  onClose: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const { data: saved } = useQuery({ queryKey: ['chequeConfig', bankLedgerId], queryFn: () => api.cheque.config.get(bankLedgerId) })
  const [form, setForm] = useState<ChequeConfig | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState<ChequeConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [printing, setPrinting] = useState(false)

  useEffect(() => {
    if (saved && !form) {
      setForm(saved)
      setSavedSnapshot(saved)
    }
  }, [saved, form])

  const dirty = form != null && savedSnapshot != null && JSON.stringify(form) !== JSON.stringify(savedSnapshot)
  useUnsavedGuard(dirty)

  const save = async (): Promise<void> => {
    if (!form) return
    setSaving(true)
    try {
      await api.cheque.config.set(bankLedgerId, form)
      setSavedSnapshot(form)
      toast.push('success', 'Cheque layout saved')
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const printGrid = async (): Promise<void> => {
    if (!form) return
    setPrinting(true)
    try {
      // Save first so the printed grid reflects any unsaved edits in the form.
      await api.cheque.config.set(bankLedgerId, form)
      setSavedSnapshot(form)
      const r = await api.cheque.testGrid(bankLedgerId)
      toast.push('success', `Test grid: ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setPrinting(false)
    }
  }

  return (
    <Modal title={`Cheque setup — ${bankLedgerName}`} onClose={onClose} wide dirty={dirty}>
      {!form ? (
        <p className="text-[13px] text-muted">Loading…</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-4 gap-3">
            <MmField label="Cheque width (mm)" value={form.widthMm} onChange={(n) => setForm({ ...form, widthMm: n })} />
            <MmField label="Cheque height (mm)" value={form.heightMm} onChange={(n) => setForm({ ...form, heightMm: n })} />
            <div className="col-span-2 flex items-end pb-1.5">
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={form.acPayee}
                  onChange={(e) => setForm({ ...form, acPayee: e.target.checked })}
                />
                Print &quot;A/C Payee only&quot; stamp
              </label>
            </div>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Date boxes</p>
            <div className="grid grid-cols-4 gap-3">
              <MmField label="X (mm)" value={form.date.xMm} onChange={(n) => setForm({ ...form, date: { ...form.date, xMm: n } })} />
              <MmField label="Y (mm)" value={form.date.yMm} onChange={(n) => setForm({ ...form, date: { ...form.date, yMm: n } })} />
              <MmField
                label="Digit gap (mm)"
                value={form.date.charGapMm}
                onChange={(n) => setForm({ ...form, date: { ...form.date, charGapMm: n } })}
              />
            </div>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Payee</p>
            <div className="grid grid-cols-4 gap-3">
              <MmField label="X (mm)" value={form.payee.xMm} onChange={(n) => setForm({ ...form, payee: { ...form.payee, xMm: n } })} />
              <MmField label="Y (mm)" value={form.payee.yMm} onChange={(n) => setForm({ ...form, payee: { ...form.payee, yMm: n } })} />
            </div>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Amount in words</p>
            <div className="grid grid-cols-4 gap-3">
              <MmField label="X (mm)" value={form.words.xMm} onChange={(n) => setForm({ ...form, words: { ...form.words, xMm: n } })} />
              <MmField label="Y (mm)" value={form.words.yMm} onChange={(n) => setForm({ ...form, words: { ...form.words, yMm: n } })} />
              <MmField label="Width (mm)" value={form.words.wMm} onChange={(n) => setForm({ ...form, words: { ...form.words, wMm: n } })} />
            </div>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Amount in figures</p>
            <div className="grid grid-cols-4 gap-3">
              <MmField
                label="X (mm)"
                value={form.figures.xMm}
                onChange={(n) => setForm({ ...form, figures: { ...form.figures, xMm: n } })}
              />
              <MmField
                label="Y (mm)"
                value={form.figures.yMm}
                onChange={(n) => setForm({ ...form, figures: { ...form.figures, yMm: n } })}
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button disabled={printing} onClick={() => void printGrid()}>
              Print test grid
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
