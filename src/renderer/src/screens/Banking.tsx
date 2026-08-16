import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ChequeConfig } from '@shared/schemas'
import { api, type BankImportResult, type BankRuleRecord, type BankSuggestionRow, type BrsItem } from '../lib/client'
import { useNav, useSession, useToasts, nextDraftId } from '../state/stores'
import {
  Button, DateInput, EmptyState, Field, Modal, Money, Panel, ScrollList, SectionTitle, Select, Spinner, TextInput
} from '../components/ui'
import { LedgerPicker } from '../components/pickers'
import { toDisplayDate, todayISO } from '@shared/dates'
import { suggestPattern } from '@shared/bankRules'
import { confirmDialog } from '../lib/dialogs'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'

type BankTab = 'recon' | 'brs' | 'pdc'

const TAB_LABELS: Record<BankTab, string> = { recon: 'Reconcile', brs: 'BRS', pdc: 'Post-dated' }

export function BankingScreen(): React.JSX.Element {
  const nav = useNav()
  const { from, to } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: ledgers } = useQuery({ queryKey: ['bankLedgers'], queryFn: api.bank.ledgers })
  const [tab, setTab] = useState<BankTab>('recon')
  const [ledgerId, setLedgerId] = useState<number | null>(null)
  const [suggestions, setSuggestions] = useState<BankSuggestionRow[] | null>(null)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [rulesPrefill, setRulesPrefill] = useState<{ pattern: string; kind: 'payment' | 'receipt' } | null>(null)
  const [rulesModalKey, setRulesModalKey] = useState(0)
  const [chequeSetupOpen, setChequeSetupOpen] = useState(false)
  const [dateEdit, setDateEdit] = useState<{ lineId: number; current: string | null } | null>(null)
  const [importPreview, setImportPreview] = useState<(BankImportResult & { csvText: string }) | null>(null)

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

  const refresh = (): Promise<void> =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['bankRecon'] }),
      queryClient.invalidateQueries({ queryKey: ['brs'] })
    ]).then(() => undefined)

  const markToday = async (lineId: number, current: string | null): Promise<void> => {
    try {
      await api.bank.setBankDate(lineId, current ? null : todayISO())
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  /** Step 1 of the import: dry-run parse+match, then show the preview modal to confirm. */
  const doImport = async (): Promise<void> => {
    if (ledgerId == null) return
    try {
      const result = await api.bank.importCsv(ledgerId, { dryRun: true })
      if (!result) return // file dialog cancelled
      if (result.statementRows === 0) return void toast.push('warning', 'No statement rows found in that CSV')
      setImportPreview(result)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  /** Step 2: the user confirmed the preview — apply the same CSV for real. */
  const applyImport = async (): Promise<void> => {
    if (ledgerId == null || !importPreview) return
    let result
    try {
      result = await api.bank.importCsv(ledgerId, { csvText: importPreview.csvText, dryRun: false })
    } catch (err) {
      toast.push('error', (err as Error).message)
      return
    }
    setImportPreview(null)
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
        <SectionTitle>Banking</SectionTitle>
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
            {tab !== 'pdc' && (
              <Select
                value={ledgerId ?? ''}
                onChange={(e) => setLedgerId(Number(e.target.value))}
                className="w-52"
                data-testid="banking-ledger"
              >
                {(ledgers ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
            {tab === 'recon' && (
              <>
                <Button data-testid="btn-banking-rules" onClick={() => openRules(null)}>
                  Rules…
                </Button>
                {ledgerId != null && (
                  <Button data-testid="btn-banking-cheque-setup" onClick={() => setChequeSetupOpen(true)}>
                    Cheque setup…
                  </Button>
                )}
                <Button variant="primary" data-testid="btn-banking-import" onClick={() => void doImport()}>
                  Import statement CSV
                </Button>
              </>
            )}
          </div>
        }
      >
        Banking
      </SectionTitle>

      <div className="mb-3 flex items-center gap-1">
        {(['recon', 'brs', 'pdc'] as const).map((t) => (
          <button
            key={t}
            data-testid={`tab-banking-${t}`}
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 text-[13px] ${tab === t ? 'bg-amberbar/20 font-medium text-ink' : 'text-muted hover:bg-panel2 hover:text-ink'}`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === 'recon' && recon && (
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

          <Panel scroll={{ maxH: '58vh' }}>
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
                    <tr key={r.lineId} data-row-id={r.lineId} className={r.bankDate ? 'opacity-60' : ''}>
                      <td className="num text-muted">{toDisplayDate(r.date)}</td>
                      <td className="max-w-56 truncate">{r.particulars}</td>
                      <td className="num text-muted">{r.instrumentNo ?? ''}</td>
                      <td className="r"><Money paise={r.deposit} /></td>
                      <td className="r"><Money paise={r.withdrawal} /></td>
                      <td>
                        <button
                          className="num text-[12px] text-blue hover:underline"
                          data-testid="btn-banking-edit-bank-date"
                          onClick={() => setDateEdit({ lineId: r.lineId, current: r.bankDate })}
                        >
                          {r.bankDate ? toDisplayDate(r.bankDate) : 'Set date'}
                        </button>
                      </td>
                      <td className="r">
                        <button
                          className="text-[12px] text-muted hover:text-ink"
                          data-testid="btn-banking-mark-today"
                          onClick={() => void markToday(r.lineId, r.bankDate)}
                        >
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
                <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
                  Unmatched statement lines · {suggestions.length}
                </p>
              </div>
              <ScrollList maxH="40vh">
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
                  <tbody data-testid="rows-banking-unmatched">
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
                          <button
                            className="mr-3 text-[12px] text-blue hover:underline"
                            data-testid="btn-banking-create-voucher"
                            onClick={() => void createFromSuggestion(s)}
                          >
                            Create voucher
                          </button>
                          <button
                            className="text-[12px] text-muted hover:text-ink"
                            data-testid="btn-banking-remember-rule"
                            onClick={() => rememberRule(s)}
                          >
                            Remember as rule
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollList>
            </Panel>
          )}
        </>
      )}

      {tab === 'brs' && ledgerId != null && <BrsSection ledgerId={ledgerId} defaultAsOn={to} />}

      {tab === 'pdc' && <PdcSection />}

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
      {dateEdit && (
        <BankDateModal
          lineId={dateEdit.lineId}
          current={dateEdit.current}
          context={to}
          onDone={() => {
            setDateEdit(null)
            void refresh()
          }}
          onClose={() => setDateEdit(null)}
        />
      )}
      {importPreview && (
        <ImportPreviewModal
          preview={importPreview}
          onApply={() => void applyImport()}
          onClose={() => setImportPreview(null)}
        />
      )}
    </div>
  )
}

/** Bank-date editor: proper DateInput (Tally shorthand + inline parse errors) instead of a text prompt. */
function BankDateModal({
  lineId,
  current,
  context,
  onDone,
  onClose
}: {
  lineId: number
  current: string | null
  /** Date context for shorthand parsing (period end). */
  context: string
  onDone: () => void
  onClose: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const [date, setDate] = useState(current ?? todayISO())
  const [saving, setSaving] = useState(false)

  const set = async (value: string | null): Promise<void> => {
    setSaving(true)
    try {
      await api.bank.setBankDate(lineId, value)
      onDone()
    } catch (err) {
      toast.push('error', (err as Error).message)
      setSaving(false)
    }
  }

  return (
    <Modal title="Bank date" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field label="Cleared at the bank on" hint="Shorthand works: 7, 7/4, t (today), y (yesterday)">
          <DateInput value={date} context={context} onChange={setDate} testId="input-bank-date" className="w-40" />
        </Field>
        <div className="flex justify-between gap-2">
          <span>
            {current && (
              <Button variant="danger" disabled={saving} data-testid="btn-banking-clear-bank-date" onClick={() => void set(null)}>
                Clear bank date
              </Button>
            )}
          </span>
          <span className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={saving} data-testid="btn-banking-set-bank-date" onClick={() => void set(date)}>
              Set date
            </Button>
          </span>
        </div>
      </div>
    </Modal>
  )
}

/** Dry-run import preview: what will reconcile, what's already done, what stays unmatched —
 *  nothing is written until the user confirms. */
function ImportPreviewModal({
  preview,
  onApply,
  onClose
}: {
  preview: BankImportResult & { csvText: string }
  onApply: () => void
  onClose: () => void
}): React.JSX.Element {
  const [applying, setApplying] = useState(false)
  return (
    <Modal title="Import preview" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-3">
          <Panel className="px-4 py-2.5">
            <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">Will reconcile</p>
            <p className="num mt-1 text-[15px] font-medium">{preview.matched} <span className="text-[11px] text-muted">of {preview.statementRows} rows</span></p>
          </Panel>
          <Panel className="px-4 py-2.5">
            <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">Already reconciled</p>
            <p className="num mt-1 text-[15px] font-medium">{preview.alreadyReconciled}</p>
          </Panel>
          <Panel className="px-4 py-2.5">
            <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">Unmatched</p>
            <p className="num mt-1 text-[15px] font-medium">{preview.unmatched.length}</p>
          </Panel>
        </div>

        {preview.matches.length > 0 && (
          <div>
            <p className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Matched book entries</p>
            <ScrollList maxH="30vh" className="rounded-md border border-line">
              <table className="ledger-table">
                <tbody data-testid="rows-banking-import-matches">
                  {preview.matches.map((m, i) => (
                    <tr key={i}>
                      <td className="num w-24 text-muted">{toDisplayDate(m.date)}</td>
                      <td className="max-w-80 truncate">{m.description}</td>
                      <td className="w-24 capitalize text-muted">{m.kind}</td>
                      <td className="num r w-32"><Money paise={m.amount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollList>
          </div>
        )}

        {preview.unmatched.length > 0 && (
          <div>
            <p className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Unmatched statement lines</p>
            <ScrollList maxH="24vh" className="rounded-md border border-line">
              <table className="ledger-table">
                <tbody data-testid="rows-banking-import-unmatched">
                  {preview.unmatched.map((u, i) => (
                    <tr key={i}>
                      <td className="num w-24 text-muted">{toDisplayDate(u.date)}</td>
                      <td className="max-w-80 truncate">{u.description}</td>
                      <td className="w-24 capitalize text-muted">{u.kind}</td>
                      <td className="num r w-32"><Money paise={u.amount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollList>
            <p className="mt-1 text-[11.5px] text-muted">After applying, unmatched lines get ledger suggestions so you can create the missing vouchers.</p>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={applying || preview.matched === 0}
            data-testid="btn-banking-apply-import"
            onClick={() => {
              setApplying(true)
              onApply()
            }}
          >
            {preview.matched === 0 ? 'Nothing to reconcile' : `Reconcile ${preview.matched} ${preview.matched === 1 ? 'entry' : 'entries'}`}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** Bank Reconciliation Statement as on a date: book balance → uncredited/unpresented → bank balance. */
function BrsSection({ ledgerId, defaultAsOn }: { ledgerId: number; defaultAsOn: string }): React.JSX.Element {
  const toast = useToasts()
  const [asOn, setAsOn] = useState(defaultAsOn)
  const [printing, setPrinting] = useState(false)
  const { data: brs, isLoading } = useQuery({
    queryKey: ['brs', ledgerId, asOn],
    queryFn: () => api.bank.brs(ledgerId, asOn)
  })

  const pdf = async (): Promise<void> => {
    setPrinting(true)
    try {
      const r = await api.bank.brsPdf(ledgerId, asOn)
      toast.push('success', `BRS PDF: ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setPrinting(false)
    }
  }

  const itemTable = (items: BrsItem[], testId: string): React.JSX.Element =>
    items.length === 0 ? (
      <p className="px-4 py-3 text-[12.5px] text-muted">None</p>
    ) : (
      <ScrollList maxH="32vh">
        <table className="ledger-table">
          <thead>
            <tr>
              <th className="w-24">Date</th>
              <th className="w-24">Number</th>
              <th>Particulars</th>
              <th className="w-28">Instrument</th>
              <th className="r w-32">Amount</th>
            </tr>
          </thead>
          <tbody data-testid={testId}>
            {items.map((it) => (
              <tr key={it.lineId} data-row-id={it.voucherId}>
                <td className="num text-muted">{toDisplayDate(it.date)}</td>
                <td className="num text-muted">{it.number}</td>
                <td className="max-w-64 truncate">{it.particulars}</td>
                <td className="num text-muted">{it.instrumentNo ?? ''}</td>
                <td className="r"><Money paise={it.amount} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollList>
    )

  return (
    <>
      <div className="mb-3 flex items-end justify-between">
        <Field label="As on">
          <DateInput value={asOn} context={defaultAsOn} onChange={setAsOn} testId="input-brs-date" className="w-40" />
        </Field>
        <Button disabled={printing || !brs} data-testid="btn-banking-brs-pdf" onClick={() => void pdf()}>
          Export PDF
        </Button>
      </div>

      {isLoading || !brs ? (
        <Panel className="flex items-center justify-center py-10">
          <Spinner />
        </Panel>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-4 gap-3">
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">Balance as per books</p>
              <p className="num mt-1 text-[15px] font-medium"><Money paise={brs.bookBalance} signed /></p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">Deposited, not credited</p>
              <p className="num mt-1 text-[15px] font-medium"><Money paise={brs.uncreditedTotal} /></p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">Issued, not presented</p>
              <p className="num mt-1 text-[15px] font-medium"><Money paise={brs.unpresentedTotal} /></p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">Balance as per bank</p>
              <p className="num mt-1 text-[15px] font-medium"><Money paise={brs.bankBalance} signed /></p>
            </Panel>
          </div>

          <Panel className="mb-3">
            <div className="border-b border-line px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
                Deposits not yet credited by the bank · {brs.uncredited.length}
              </p>
            </div>
            {itemTable(brs.uncredited, 'rows-banking-brs-uncredited')}
          </Panel>

          <Panel>
            <div className="border-b border-line px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
                Cheques issued, not yet presented · {brs.unpresented.length}
              </p>
            </div>
            {itemTable(brs.unpresented, 'rows-banking-brs-unpresented')}
          </Panel>
        </>
      )}
    </>
  )
}

/** Post-dated voucher register: everything waiting to mature, with early-mature and edit actions. */
function PdcSection(): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: rows, isLoading } = useQuery({ queryKey: ['pdc'], queryFn: api.pdc.list })

  const mature = async (id: number, number: string): Promise<void> => {
    const proceed = await confirmDialog({
      title: 'Mature now',
      message: `Bring post-dated voucher ${number} into the books now? It will start counting in reports and balances immediately.`,
      confirmLabel: 'Mature now'
    })
    if (!proceed) return
    try {
      await api.pdc.mature(id)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['pdc'] }),
        queryClient.invalidateQueries({ queryKey: ['bankRecon'] }),
        queryClient.invalidateQueries({ queryKey: ['brs'] })
      ])
      toast.push('success', `${number} matured into the books`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Panel scroll={{ maxH: '64vh' }}>
      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Spinner />
        </div>
      ) : !rows?.length ? (
        <EmptyState
          title="No post-dated vouchers"
          hint="Tick “Post-dated” on a payment or receipt to keep it out of the books until its date arrives"
        />
      ) : (
        <table className="ledger-table">
          <thead>
            <tr>
              <th className="w-24">Matures</th>
              <th className="w-24">Number</th>
              <th className="w-28">Type</th>
              <th>Party</th>
              <th className="w-28">Instrument</th>
              <th className="r w-32">Amount</th>
              <th className="w-36"></th>
            </tr>
          </thead>
          <tbody data-testid="rows-banking-pdc">
            {rows.map((r) => (
              <tr key={r.id} data-row-id={r.id} className="hover:bg-panel2">
                <td className="num text-muted">{toDisplayDate(r.date)}</td>
                <td className="num">{r.number}</td>
                <td className="text-muted">{r.voucherTypeName}</td>
                <td className="max-w-52 truncate">{r.partyName ?? ''}</td>
                <td className="num text-muted">{r.instrumentNo ?? ''}</td>
                <td className="r"><Money paise={r.amount} /></td>
                <td className="r">
                  <button
                    className="mr-3 text-[12px] text-blue hover:underline"
                    data-testid="btn-banking-pdc-mature"
                    onClick={() => void mature(r.id, r.number)}
                  >
                    Mature now
                  </button>
                  <button
                    className="text-[12px] text-muted hover:text-ink"
                    data-testid="btn-banking-pdc-edit"
                    onClick={() => nav.go({ name: 'voucher-entry', voucherId: r.id })}
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
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
          <ScrollList maxH="40vh">
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
              <tbody data-testid="rows-banking-rules">
                {rules.map((r) => (
                  <tr key={r.id} data-row-id={r.id} className="hover:bg-panel2">
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
          </ScrollList>
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
            <Button variant="primary" disabled={saving} data-testid="btn-banking-save-rule" onClick={() => void save()}>
              {editingId ? 'Save changes' : 'Add rule'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** mm-offset number field — ui-kit TextInput (no rupee/date parsing needed here). */
function MmField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }): React.JSX.Element {
  return (
    <Field label={label}>
      <TextInput
        type="number"
        step="0.5"
        className="num text-right"
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
  const {
    data: saved,
    error: loadError,
    refetch
  } = useQuery({ queryKey: ['chequeConfig', bankLedgerId], queryFn: () => api.cheque.config.get(bankLedgerId) })
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
        loadError ? (
          // A failed config load used to strand the modal on "Loading…" forever — surface the
          // error and offer a retry instead.
          <div className="flex flex-col items-start gap-3">
            <p className="text-[13px] text-cr">Couldn’t load the cheque layout: {(loadError as Error).message}</p>
            <Button data-testid="btn-banking-cheque-retry" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 py-4 text-[13px] text-muted">
            <Spinner /> Loading cheque layout…
          </div>
        )
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
            <Button disabled={printing} data-testid="btn-banking-cheque-test-grid" onClick={() => void printGrid()}>
              Print test grid
            </Button>
            <Button variant="primary" disabled={saving} data-testid="btn-banking-cheque-save" onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
