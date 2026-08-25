import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ChequeConfig } from '@shared/schemas'
import {
  api, type BankAdHocProfile, type BankBulkAcceptResult, type BankImportResult, type BankProfileColumns,
  type BankMatchSuggestion, type BankRuleRecord, type BankStatementInspection, type BankSuggestionRow,
  type BankUnmatchedRow, type BrsItem, type PdcRow
} from '../lib/client'
import { useNav, useSession, useToasts, nextDraftId } from '../state/stores'
import {
  AmountInput, Button, DateInput, EmptyState, Field, Modal, Money, Panel, ScrollList, SectionTitle, Select, SkeletonRows,
  Spinner, TextInput, useTableNav
} from '../components/ui'
import { LedgerPicker } from '../components/pickers'
import { toDisplayDate, todayISO } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { WEEKDAY_LABELS, bucketByDueDate, monthGrid, monthLabel, monthOf, monthTotal, shiftMonth } from '@shared/pdcCalendar'
import { useStickyTab } from '../lib/useStickyTab'
import { suggestPattern } from '@shared/bankRules'
import { PROFILE_FIELDS, type ProfileField } from '@shared/bankImport'
import { DEFAULT_CONFIDENCE_THRESHOLD } from '@shared/narrationMemory'
import { confirmDialog } from '../lib/dialogs'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'

type BankTab = 'status' | 'recon' | 'brs' | 'pdc'

/** How a statement is being read: a named profile, or columns mapped by hand (#131). */
type ProfileChoice = { profileId?: string | null; adHoc?: BankAdHocProfile | null }

const TAB_LABELS: Record<BankTab, string> = {
  status: 'All accounts',
  recon: 'Reconcile',
  brs: 'BRS',
  pdc: 'Post-dated'
}

export function BankingScreen(): React.JSX.Element {
  const nav = useNav()
  const { from, to } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: ledgers } = useQuery({ queryKey: ['bankLedgers'], queryFn: api.bank.ledgers })
  const [tab, setTab] = useStickyTab<BankTab>('banking', ['status', 'recon', 'brs', 'pdc'], 'status')
  const [ledgerId, setLedgerId] = useState<number | null>(null)
  const [suggestions, setSuggestions] = useState<BankSuggestionRow[] | null>(null)
  const [matches, setMatches] = useState<BankMatchSuggestion[] | null>(null)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [rulesPrefill, setRulesPrefill] = useState<{ pattern: string; kind: 'payment' | 'receipt' } | null>(null)
  const [rulesModalKey, setRulesModalKey] = useState(0)
  const [chequeSetupOpen, setChequeSetupOpen] = useState(false)
  const [dateEdit, setDateEdit] = useState<{ lineId: number; current: string | null } | null>(null)
  const [importPreview, setImportPreview] = useState<(BankImportResult & { csvText: string }) | null>(null)
  // The file the user picked, plus how it is being read. Carried through mapping → preview →
  // apply → suggestions → bulk accept so every step reads the same bytes the same way (#131).
  const [mapping, setMapping] = useState<BankStatementInspection | null>(null)
  const [reading, setReading] = useState<{ csvText: string; choice: ProfileChoice } | null>(null)
  const [threshold, setThreshold] = useState(DEFAULT_CONFIDENCE_THRESHOLD)
  const [bulkPreview, setBulkPreview] = useState<BankBulkAcceptResult | null>(null)
  const [inlineRule, setInlineRule] = useState<{ row: BankUnmatchedRow; ruleId: number | null; ledgerId: number | null } | null>(null)
  const [freezeOpen, setFreezeOpen] = useState(false)

  // #142: the freeze is per bank account, so the header states the selected account's own lock
  // rather than a global one — "frozen" without saying which account is what makes an operator
  // stop trusting the message.
  const { data: reconLocks } = useQuery({ queryKey: ['bankReconLocks'], queryFn: api.bank.reconLocks })
  const lockedTo = (reconLocks ?? []).find((l) => l.ledgerId === ledgerId)?.lockedTo ?? null

  useEffect(() => {
    if (ledgerId == null && ledgers?.length) setLedgerId(ledgers[0]!.id)
  }, [ledgers, ledgerId])

  // A new bank ledger's statement lines have nothing to do with the last one's suggestions.
  useEffect(() => {
    setSuggestions(null)
    setMatches(null)
    setReading(null)
  }, [ledgerId])

  const { data: recon } = useQuery({
    queryKey: ['bankRecon', ledgerId, from, to],
    queryFn: () => api.bank.recon(ledgerId!, from, to),
    enabled: ledgerId != null
  })

  // Enter opens the voucher behind the selected statement line. Gated on the Reconcile tab so
  // the BRS and post-dated tables never compete for the arrow keys.
  const reconTable = useTableNav(recon?.rows ?? [], {
    rowId: (r) => r.lineId,
    enabled: tab === 'recon',
    onEnter: (r) => nav.go({ name: 'voucher-entry', voucherId: r.voucherId })
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

  /** Re-read the unmatched lines under the same profile, so suggestions never drift from the
   *  file that produced them. */
  const reloadSuggestions = async (csvText: string, choice: ProfileChoice, announce = false): Promise<void> => {
    if (ledgerId == null) return
    try {
      const rows = await api.bank.suggest(ledgerId, csvText, choice)
      setSuggestions(rows)
      // The second pass over the same rows (#144). Read from the same bytes in the same call so
      // a group can never be proposed against a statement the list below has moved on from.
      setMatches(await api.bank.matchSuggestions(ledgerId, csvText))
      const withSuggestion = rows.filter((r) => r.suggestion).length
      if (announce && withSuggestion > 0) {
        toast.push('info', `${withSuggestion} of ${rows.length} unmatched lines have a suggested ledger below`)
      }
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  /** Dry-run parse+match under a chosen profile, then show the preview modal to confirm. */
  const dryRun = async (csvText: string, choice: ProfileChoice): Promise<void> => {
    if (ledgerId == null) return
    try {
      const result = await api.bank.importCsv(ledgerId, { csvText, dryRun: true, ...choice })
      if (!result) return
      if (result.statementRows === 0) {
        // Zero readable rows out of a file that clearly has some is the signature of the wrong
        // columns, so send the user to the mapper rather than to a dead end.
        toast.push('warning', 'No statement rows could be read — check the column mapping')
        const inspection = await api.bank.inspectStatement({ csvText, ...choice })
        if (inspection) setMapping(inspection)
        return
      }
      setReading({ csvText, choice })
      setImportPreview(result)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  /** Step 1: pick the file, work out which bank wrote it, and only then decide what to show. */
  const doImport = async (): Promise<void> => {
    if (ledgerId == null) return
    try {
      const inspection = await api.bank.inspectStatement({})
      if (!inspection) return // file dialog cancelled
      if (inspection.error || inspection.rowsReadable === 0) {
        setMapping(inspection)
        return
      }
      await dryRun(inspection.csvText, { profileId: inspection.profileId })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  /** Step 2: the user confirmed the preview — apply the same CSV, read the same way, for real. */
  const applyImport = async (): Promise<void> => {
    if (ledgerId == null || !importPreview || !reading) return
    let result
    try {
      result = await api.bank.importCsv(ledgerId, { csvText: reading.csvText, dryRun: false, ...reading.choice })
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
    await reloadSuggestions(reading.csvText, reading.choice, true)
  }

  /** Bulk accept (#134): preview first — the count and the total are computed by the same pass
   *  that will do the work, so the confirmation cannot describe a different set of rows. */
  const previewBulkAccept = async (): Promise<void> => {
    if (ledgerId == null || !reading) return
    try {
      setBulkPreview(await api.bank.bulkAccept(ledgerId, reading.csvText, threshold, { apply: false, ...reading.choice }))
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const applyBulkAccept = async (): Promise<void> => {
    if (ledgerId == null || !reading) return
    try {
      const result = await api.bank.bulkAccept(ledgerId, reading.csvText, threshold, { apply: true, ...reading.choice })
      setBulkPreview(null)
      toast.push('success', `${result.count} ${result.count === 1 ? 'voucher' : 'vouchers'} filed and reconciled`)
      await refresh()
      await reloadSuggestions(reading.csvText, reading.choice)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const createFromSuggestion = async (row: BankSuggestionRow): Promise<void> => {
    if (row.suggestion) {
      try {
        if (row.suggestion.ruleId != null) await api.bankRules.hit(row.suggestion.ruleId)
        // Taking the suggestion is the user saying this narration means this ledger, which is
        // exactly the evidence #133 learns from.
        await api.bank.learn(row.statementRow.description, row.suggestion.ledgerId, row.suggestion.kind)
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

  /**
   * Accept a grouped or near match (#144).
   *
   * One statement line, several book entries: every line in the group takes the statement row's
   * date, because they were all cleared by the same credit, and a group reconciled at two
   * different dates is a group nobody can unpick later.
   *
   * Sequentially, and stopping at the first refusal: the reconciliation freeze (#142) answers the
   * same way for every line of one account, so a lock stops the whole group before anything is
   * written rather than leaving half a settlement reconciled.
   */
  const acceptMatch = async (match: BankMatchSuggestion): Promise<void> => {
    try {
      for (const line of match.lines) await api.bank.setBankDate(line.lineId, match.statementRow.date)
      toast.push(
        'success',
        `${match.lines.length} ${match.lines.length === 1 ? 'entry' : 'entries'} reconciled against ${match.statementRow.description}`
      )
      await refresh()
      if (reading) await reloadSuggestions(reading.csvText, reading.choice)
    } catch (err) {
      // Carries the freeze's "Reconciliation is frozen up to …" — the one message that explains
      // why an otherwise obvious match refuses to go through.
      toast.push('error', (err as Error).message)
    }
  }

  /** #135: create the four charge/interest ledgers, then re-read the same statement so the rows
   *  that had nowhere to post now carry a suggestion instead of a dead end. */
  const setupChargeLedgers = async (): Promise<void> => {
    try {
      const result = await api.bank.setupChargeLedgers()
      await queryClient.invalidateQueries({ queryKey: ['ledgers'] })
      toast.push(
        result.created.length > 0 ? 'success' : 'info',
        result.created.length > 0
          ? `Created ${result.created.join(', ')}`
          : `Already there: ${result.existing.join(', ')}`
      )
      if (reading) await reloadSuggestions(reading.csvText, reading.choice)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const openRules = (prefill: { pattern: string; kind: 'payment' | 'receipt' } | null): void => {
    setRulesPrefill(prefill)
    setRulesModalKey((k) => k + 1)
    setRulesOpen(true)
  }

  /** #147: the rule for a row is edited from the row. Prefilled from the narration, and pointed
   *  at the existing rule when one already fired, so "nearly right" is a correction rather than a
   *  second rule competing with the first. */
  const editRuleFor = (row: BankSuggestionRow): void => {
    setInlineRule({
      row: row.statementRow,
      ruleId: row.suggestion?.ruleId ?? null,
      ledgerId: row.suggestion?.ledgerId ?? null
    })
  }

  // What the bulk-accept button would take, counted the same way the service counts it: at or
  // above the bar, and never an ambiguous one.
  const acceptableCount = (suggestions ?? []).filter(
    (r) => r.suggestion && !r.suggestion.ambiguous && r.suggestion.confidence >= threshold
  ).length

  // Rows the narration says are the bank's own charge, with no ledger behind them (#135). The
  // count is what makes the offer worth making — one stray row is noise, eleven is a missing
  // chart of accounts.
  const unpostableCharges = (suggestions ?? []).filter((r) => r.chargeCategory && !r.suggestion).length

  if (ledgers && ledgers.length === 0) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col max-w-[1440px]">
        <SectionTitle>Banking</SectionTitle>
        <Panel>
          <EmptyState title="No bank ledgers yet" hint="Create a ledger under Bank Accounts in Masters, then reconcile it here" />
        </Panel>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col max-w-[1440px]">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            {tab !== 'pdc' && tab !== 'status' && (
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
                {ledgerId != null && (
                  <>
                    <span className="text-hint text-muted" data-testid="banking-recon-lock">
                      {lockedTo ? `Frozen up to ${toDisplayDate(lockedTo)}` : 'Not frozen'}
                    </span>
                    <Button data-testid="btn-recon-freeze" onClick={() => setFreezeOpen(true)}>
                      Freeze…
                    </Button>
                  </>
                )}
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
        {(['status', 'recon', 'brs', 'pdc'] as const).map((t) => (
          <button
            key={t}
            data-testid={`tab-banking-${t}`}
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 text-detail ${tab === t ? 'bg-amberbar/20 font-medium text-ink' : 'text-muted hover:bg-panel2 hover:text-ink'}`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === 'status' && <ReconciliationStatusPanel asOn={to} />}

      {tab === 'recon' && recon && (
        <>
          <div className="mb-3 grid grid-cols-4 gap-3">
            <Panel className="px-4 py-2.5">
              <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Balance as per books</p>
              <p className="num mt-1 text-lead font-medium"><Money paise={recon.bookBalance} /></p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Deposits not in bank</p>
              <p className="num mt-1 text-lead font-medium"><Money paise={recon.unreconciledDeposits} /></p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Withdrawals not in bank</p>
              <p className="num mt-1 text-lead font-medium"><Money paise={recon.unreconciledWithdrawals} /></p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Balance as per bank</p>
              <p className="num mt-1 text-lead font-medium"><Money paise={recon.bankBalance} /></p>
            </Panel>
          </div>

          <Panel scroll={{ maxH: '58vh' }}>
            {recon.rows.length === 0 ? (
              <EmptyState title="No bank entries in this period" />
            ) : (
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th scope="col" className="w-24">Date</th>
                    <th scope="col">Particulars</th>
                    <th scope="col" className="w-28">Instrument</th>
                    <th scope="col" className="r w-32">Deposit</th>
                    <th scope="col" className="r w-32">Withdrawal</th>
                    <th scope="col" className="w-32">Bank date</th>
                    <th scope="col" className="w-24"></th>
                  </tr>
                </thead>
                <tbody data-testid="rows-banking">
                  {recon.rows.map((r, i) => (
                    <tr
                      key={r.lineId}
                      {...reconTable.rowProps(i, r)}
                      className={`${reconTable.rowProps(i, r).className} ${r.bankDate ? 'opacity-60' : ''}`}
                    >
                      <td className="num text-muted">{toDisplayDate(r.date)}</td>
                      <td className="max-w-56 truncate">{r.particulars}</td>
                      <td className="num text-muted">{r.instrumentNo ?? ''}</td>
                      <td className="r"><Money paise={r.deposit} /></td>
                      <td className="r"><Money paise={r.withdrawal} /></td>
                      <td>
                        <button
                          className="num text-small text-blue hover:underline"
                          data-testid="btn-banking-edit-bank-date"
                          onClick={() => setDateEdit({ lineId: r.lineId, current: r.bankDate })}
                        >
                          {r.bankDate ? toDisplayDate(r.bankDate) : 'Set date'}
                        </button>
                      </td>
                      <td className="r">
                        <button
                          className="text-small text-muted hover:text-ink"
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
          <p className="mt-2 text-hint text-muted">
            Import a statement CSV (date + debit/credit columns) to auto-match by amount and date; anything left over, set the bank date by hand.
          </p>

          {suggestions && suggestions.length > 0 && (
            <Panel className="mt-3">
              <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
                <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">
                  Unmatched statement lines · {suggestions.length}
                </p>
                {/* Bulk accept (#134): the bar is stated, the count under it is stated, and
                    nothing happens until the confirmation shows both plus the money. */}
                <div className="flex items-center gap-2">
                  <span className="text-hint text-muted">Accept at or above</span>
                  <Select
                    value={threshold}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                    className="w-24"
                    data-testid="select-banking-threshold"
                  >
                    <option value={100}>100%</option>
                    <option value={90}>90%</option>
                    <option value={80}>80%</option>
                    <option value={70}>70%</option>
                  </Select>
                  <Button
                    disabled={!reading || acceptableCount === 0}
                    data-testid="btn-banking-bulk-accept"
                    onClick={() => void previewBulkAccept()}
                  >
                    Accept {acceptableCount} high-confidence
                  </Button>
                </div>
              </div>
              {/* #135: the bank's own charges are recognised whether or not there is a ledger to
                  put them in. When there isn't, saying so once above the list beats repeating
                  "No match" on eleven rows that all have the same single cause. */}
              {unpostableCharges > 0 && (
                <div
                  className="flex items-center justify-between gap-3 border-b border-line bg-panel2 px-4 py-2.5"
                  data-testid="banking-charge-notice"
                >
                  <p className="text-detail text-ink">
                    {unpostableCharges} {unpostableCharges === 1 ? 'row looks' : 'rows look'} like the bank’s own
                    charges and interest — there is nowhere to post them yet.
                  </p>
                  <Button data-testid="btn-setup-charge-ledgers" onClick={() => void setupChargeLedgers()}>
                    Create charge ledgers
                  </Button>
                </div>
              )}
              <ScrollList maxH="40vh">
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th scope="col" className="w-24">Date</th>
                      <th scope="col">Description</th>
                      <th scope="col" className="r w-32">Amount</th>
                      <th scope="col" className="w-56">Suggested ledger</th>
                      <th scope="col" className="r w-24">Confidence</th>
                      <th scope="col" className="w-52"></th>
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
                            <span className="flex items-center gap-1.5">
                              <span className="rounded-md px-1.5 py-0.5 text-label bg-blue/10 text-blue">{s.suggestion.ledgerName}</span>
                              {/* Where a suggestion came from changes how much it is worth
                                  trusting, so it is on the row rather than in a tooltip. */}
                              <span className="text-hint text-muted" data-testid="banking-suggestion-source">
                                {s.suggestion.source === 'rule'
                                  ? 'rule'
                                  : s.suggestion.source === 'charge'
                                    ? "bank's own charge"
                                    : `learned: ${s.suggestion.matched.join(' ')}`}
                              </span>
                            </span>
                          ) : (
                            <span className="text-hint text-muted">No match</span>
                          )}
                        </td>
                        <td className="r num">
                          {s.suggestion ? (
                            <span
                              className={
                                s.suggestion.ambiguous
                                  ? 'text-amber'
                                  : s.suggestion.confidence >= threshold
                                    ? 'text-dr font-medium'
                                    : 'text-muted'
                              }
                              title={s.suggestion.ambiguous ? 'Two ledgers fit this narration equally — never bulk-accepted' : undefined}
                            >
                              {s.suggestion.confidence}%{s.suggestion.ambiguous ? ' ?' : ''}
                            </span>
                          ) : (
                            <span className="text-muted">–</span>
                          )}
                        </td>
                        <td className="r">
                          <button
                            className="mr-3 text-small text-blue hover:underline"
                            data-testid="btn-banking-create-voucher"
                            onClick={() => void createFromSuggestion(s)}
                          >
                            Create voucher
                          </button>
                          <button
                            className="text-small text-muted hover:text-ink"
                            data-testid="btn-banking-remember-rule"
                            onClick={() => editRuleFor(s)}
                          >
                            {s.suggestion?.ruleId != null ? 'Edit rule' : 'Rule from this row'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollList>
            </Panel>
          )}

          {matches && matches.length > 0 && (
            <MatchSuggestionsPanel matches={matches} onAccept={acceptMatch} />
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
      {freezeOpen && ledgerId != null && (
        <ReconFreezeModal
          ledgerId={ledgerId}
          ledgerName={(ledgers ?? []).find((l) => l.id === ledgerId)?.name ?? ''}
          lockedTo={lockedTo}
          context={to}
          onClose={() => setFreezeOpen(false)}
          onDone={() => {
            setFreezeOpen(false)
            void queryClient.invalidateQueries({ queryKey: ['bankReconLocks'] })
          }}
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
          onRemap={() => {
            setImportPreview(null)
            if (!reading) return
            void api.bank
              .inspectStatement({ csvText: reading.csvText, ...reading.choice })
              .then((inspection) => inspection && setMapping(inspection))
          }}
          onApply={() => void applyImport()}
          onClose={() => setImportPreview(null)}
        />
      )}
      {mapping && (
        <ColumnMappingModal
          inspection={mapping}
          onUse={(choice) => {
            setMapping(null)
            void dryRun(mapping.csvText, choice)
          }}
          onClose={() => setMapping(null)}
        />
      )}
      {bulkPreview && (
        <BulkAcceptModal
          preview={bulkPreview}
          onApply={() => void applyBulkAccept()}
          onClose={() => setBulkPreview(null)}
        />
      )}
      {inlineRule && ledgerId != null && (
        <InlineRuleModal
          row={inlineRule.row}
          ruleId={inlineRule.ruleId}
          suggestedLedgerId={inlineRule.ledgerId}
          onClose={() => setInlineRule(null)}
          onSaved={() => {
            setInlineRule(null)
            if (reading) void reloadSuggestions(reading.csvText, reading.choice)
          }}
        />
      )}
    </div>
  )
}

/**
 * Statement lines that match a GROUP of book entries, or miss a single one narrowly (#144).
 *
 * The exact matcher works one-to-one, so the commonest settlement in a small business — one NEFT
 * paying three invoices — falls out of it as an unmatched line, and the operator ends up setting
 * three bank dates by hand after adding the amounts up on paper.
 *
 * The service finds the combination; it deliberately does not accept it. A set of three amounts
 * summing to a fourth is a coincidence that happens often enough to matter, and the only party
 * who can tell a real settlement from an arithmetic accident is the person who knows the party.
 * So every constituent voucher is shown with its number, date and amount, under a stated total —
 * the working, not just the answer.
 */
function MatchSuggestionsPanel({
  matches,
  onAccept
}: {
  matches: BankMatchSuggestion[]
  onAccept: (match: BankMatchSuggestion) => void
}): React.JSX.Element {
  return (
    <Panel className="mt-3">
      <div className="border-b border-line px-4 py-2.5">
        <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">
          Grouped and near matches · {matches.length}
        </p>
        <p className="mt-1 text-hint text-muted">
          Entries the exact matcher could not take one-to-one. Check the vouchers add up to the statement line for the
          right reason before reconciling them.
        </p>
      </div>
      <ScrollList maxH="40vh">
        {matches.map((m, i) => {
          const sum = m.lines.reduce((s, l) => s + l.amount, 0)
          const difference = m.statementRow.amount - sum
          return (
            <div
              key={`${m.statementRow.date}-${m.statementRow.reference}-${i}`}
              className="border-b border-line px-4 py-3 last:border-b-0"
              data-testid="banking-match-suggestion"
              data-match-kind={m.kind}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-body">
                    <span className="num text-muted">{toDisplayDate(m.statementRow.date)}</span>{' '}
                    {m.statementRow.description}
                  </p>
                  <p className="mt-0.5 text-hint text-muted" data-testid="banking-match-kind">
                    {m.kind === 'many_to_one'
                      ? `${m.lines.length} entries for the same party add up to this ${m.statementRow.kind}`
                      : `One entry, off by ${formatPaise(Math.abs(difference))}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="num text-lead font-medium">
                    <Money paise={m.statementRow.amount} />
                  </span>
                  <Button
                    data-testid="btn-banking-accept-match"
                    onClick={() => onAccept(m)}
                    title={`Set the bank date to ${toDisplayDate(m.statementRow.date)} on ${m.lines.length === 1 ? 'this entry' : `all ${m.lines.length} entries`}`}
                  >
                    Reconcile {m.lines.length} {m.lines.length === 1 ? 'entry' : 'entries'}
                  </Button>
                </div>
              </div>
              <table className="ledger-table mt-2">
                <tbody data-testid="rows-banking-match-lines">
                  {m.lines.map((l) => (
                    <tr key={l.lineId} data-row-id={l.voucherId}>
                      <td className="num w-24 text-muted">{toDisplayDate(l.date)}</td>
                      <td className="num w-24">{l.number}</td>
                      <td></td>
                      <td className="r num w-32">
                        <Money paise={l.amount} />
                      </td>
                    </tr>
                  ))}
                  <tr className="total-row">
                    <td className="text-muted" colSpan={2}>
                      {m.lines.length === 1 ? 'Book entry' : `${m.lines.length} entries`}
                    </td>
                    <td className="r text-muted">
                      {/* A difference of nothing is stated as such: "they add up exactly" is the
                          fact that makes a group safe to accept, and a blank cell does not say it. */}
                      {difference === 0 ? 'adds up exactly' : `${difference > 0 ? 'short by' : 'over by'} ${formatPaise(Math.abs(difference))}`}
                    </td>
                    <td className="r num w-32">
                      <Money paise={sum} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )
        })}
      </ScrollList>
    </Panel>
  )
}

/**
 * Reconciliation freeze, one bank account at a time (#142).
 *
 * A signed-off BRS is a statement somebody has already given to a lender or an auditor. Moving a
 * bank date inside that period changes the figure they were given without changing the paper, so
 * main refuses it — this modal is where the refusal is set up and lifted, deliberately, rather
 * than being a setting three screens away from the reconciliation it governs.
 */
function ReconFreezeModal({
  ledgerId,
  ledgerName,
  lockedTo,
  context,
  onDone,
  onClose
}: {
  ledgerId: number
  ledgerName: string
  lockedTo: string | null
  /** Date context for shorthand parsing (period end). */
  context: string
  onDone: () => void
  onClose: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const [date, setDate] = useState(lockedTo ?? context)
  const [saving, setSaving] = useState(false)

  const set = async (value: string | null): Promise<void> => {
    setSaving(true)
    try {
      await api.bank.setReconLock(ledgerId, value)
      toast.push('success', value ? `${ledgerName} frozen up to ${toDisplayDate(value)}` : `${ledgerName} unfrozen`)
      onDone()
    } catch (err) {
      toast.push('error', (err as Error).message)
      setSaving(false)
    }
  }

  return (
    <Modal title="Freeze reconciliation" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-detail text-muted">
          {lockedTo
            ? `${ledgerName} is frozen up to ${toDisplayDate(lockedTo)}. Bank dates on or before that day cannot be set or cleared.`
            : `${ledgerName} is not frozen. Bank dates anywhere in its history can still be changed.`}
        </p>
        <Field label="Freeze everything up to and including" hint="Shorthand works: 7, 7/4, t (today), y (yesterday)">
          <DateInput value={date} context={context} onChange={setDate} testId="input-recon-freeze-date" className="w-40" />
        </Field>
        <div className="flex justify-between gap-2">
          <span>
            {lockedTo && (
              <Button variant="danger" disabled={saving} data-testid="btn-recon-unfreeze" onClick={() => void set(null)}>
                Unfreeze
              </Button>
            )}
          </span>
          <span className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={saving} data-testid="btn-recon-freeze-save" onClick={() => void set(date)}>
              Freeze
            </Button>
          </span>
        </div>
      </div>
    </Modal>
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
  onRemap,
  onApply,
  onClose
}: {
  preview: BankImportResult & { csvText: string }
  onRemap: () => void
  onApply: () => void
  onClose: () => void
}): React.JSX.Element {
  const [applying, setApplying] = useState(false)
  return (
    <Modal title="Import preview" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        {/* Which bank's shape was used to read the file, and what that cost — a statement read
            with the wrong profile shows up here as a large skipped count, before anything is
            written rather than after (#131). */}
        <div className="flex items-center justify-between rounded-md border border-line px-3.5 py-2 text-detail">
          <span data-testid="banking-import-profile">
            Read with <span className="font-medium text-ink">{preview.profileName}</span>
            {preview.skipped > 0 && (
              <span className="text-muted"> · {preview.skipped} {preview.skipped === 1 ? 'line' : 'lines'} not read</span>
            )}
          </span>
          <button className="text-small text-blue hover:underline" data-testid="btn-banking-remap" onClick={onRemap}>
            Change columns
          </button>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Panel className="px-4 py-2.5">
            <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Will reconcile</p>
            <p className="num mt-1 text-lead font-medium">{preview.matched} <span className="text-caption text-muted">of {preview.statementRows} rows</span></p>
          </Panel>
          <Panel className="px-4 py-2.5">
            <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Already reconciled</p>
            <p className="num mt-1 text-lead font-medium">{preview.alreadyReconciled}</p>
          </Panel>
          <Panel className="px-4 py-2.5">
            <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Unmatched</p>
            <p className="num mt-1 text-lead font-medium">{preview.unmatched.length}</p>
          </Panel>
        </div>

        {preview.matches.length > 0 && (
          <div>
            <p className="mb-1.5 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Matched book entries</p>
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
            <p className="mb-1.5 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Unmatched statement lines</p>
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
            <p className="mt-1 text-hint text-muted">After applying, unmatched lines get ledger suggestions so you can create the missing vouchers.</p>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button onClick={onClose}>Cancel</Button>
          {/* A statement can reconcile nothing and still be worth importing: its unmatched lines
              are what the suggestion list and bulk accept (#134) work on. Only a file with
              nothing at all in it is a dead end. */}
          <Button
            variant="primary"
            disabled={applying || (preview.matched === 0 && preview.unmatched.length === 0)}
            data-testid="btn-banking-apply-import"
            onClick={() => {
              setApplying(true)
              onApply()
            }}
          >
            {preview.matched > 0
              ? `Reconcile ${preview.matched} ${preview.matched === 1 ? 'entry' : 'entries'}`
              : preview.unmatched.length > 0
                ? `Continue to ${preview.unmatched.length} unmatched ${preview.unmatched.length === 1 ? 'line' : 'lines'}`
                : 'Nothing to reconcile'}
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
      <p className="px-4 py-3 text-body-sm text-muted">None</p>
    ) : (
      <ScrollList maxH="32vh">
        <table className="ledger-table">
          <thead>
            <tr>
              <th scope="col" className="w-24">Date</th>
              <th scope="col" className="w-24">Number</th>
              <th scope="col">Particulars</th>
              <th scope="col" className="w-28">Instrument</th>
              <th scope="col" className="r w-32">Amount</th>
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
              <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Balance as per books</p>
              <p className="num mt-1 text-lead font-medium"><Money paise={brs.bookBalance} signed /></p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Deposited, not credited</p>
              <p className="num mt-1 text-lead font-medium"><Money paise={brs.uncreditedTotal} /></p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Issued, not presented</p>
              <p className="num mt-1 text-lead font-medium"><Money paise={brs.unpresentedTotal} /></p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Balance as per bank</p>
              <p className="num mt-1 text-lead font-medium"><Money paise={brs.bankBalance} signed /></p>
            </Panel>
          </div>

          <Panel className="mb-3">
            <div className="border-b border-line px-4 py-2.5">
              <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">
                Deposits not yet credited by the bank · {brs.uncredited.length}
              </p>
            </div>
            {itemTable(brs.uncredited, 'rows-banking-brs-uncredited')}
          </Panel>

          <Panel>
            <div className="border-b border-line px-4 py-2.5">
              <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">
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
  const [month, setMonth] = useState(monthOf(todayISO()))
  const [bounceFor, setBounceFor] = useState<PdcRow | null>(null)

  const refreshAfterBounce = (): Promise<void> =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['bounces'] }),
      queryClient.invalidateQueries({ queryKey: ['pdc'] }),
      queryClient.invalidateQueries({ queryKey: ['bankRecon'] }),
      queryClient.invalidateQueries({ queryKey: ['brs'] })
    ]).then(() => undefined)

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

  const buckets = bucketByDueDate(rows ?? [])
  const grid = monthGrid(month)

  return (
    <>
      {/* #137: the register sorted by date answers "what is next". The month answers "how much
          clears in the week of the 15th, and is there enough in the account by then" — which is
          the question the register is actually opened for, and a list cannot show it. */}
      <Panel className="mb-3">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">
            {monthLabel(month)} · falling due{' '}
            <span className="num text-ink">{formatPaise(monthTotal(rows ?? [], month))}</span>
          </p>
          <div className="flex items-center gap-2">
            <Button aria-label="Previous month" data-testid="btn-pdc-prev-month" onClick={() => setMonth(shiftMonth(month, -1))}>
              ←
            </Button>
            <Button data-testid="btn-pdc-this-month" onClick={() => setMonth(monthOf(todayISO()))}>
              This month
            </Button>
            <Button aria-label="Next month" data-testid="btn-pdc-next-month" onClick={() => setMonth(shiftMonth(month, 1))}>
              →
            </Button>
          </div>
        </div>
        <div className="p-3" data-testid="pdc-calendar" data-month={month}>
          <div className="grid grid-cols-7 gap-1">
            {WEEKDAY_LABELS.map((w) => (
              <div key={w} className="px-1 pb-1 text-label font-semibold tracking-[0.08em] text-muted uppercase">
                {w}
              </div>
            ))}
            {grid.flat().map((cell) => {
              const bucket = buckets.get(cell.date)
              return (
                <div
                  key={cell.date}
                  data-testid="pdc-day"
                  data-date={cell.date}
                  data-in-month={cell.inMonth ? 'true' : 'false'}
                  className={`min-h-14 rounded-md border border-line px-1.5 py-1 ${
                    cell.inMonth ? 'bg-panel' : 'bg-panel2 opacity-50'
                  }`}
                >
                  <span className="num text-hint text-muted">{Number(cell.date.slice(8, 10))}</span>
                  {bucket && (
                    <span className="mt-0.5 block" title={bucket.rows.map((r) => `${r.number} ${r.partyName ?? ''}`.trim()).join('\n')}>
                      <span className="num block truncate text-detail font-medium text-ink">{formatPaise(bucket.total)}</span>
                      <span className="block text-hint text-muted">
                        {bucket.rows.length} {bucket.rows.length === 1 ? 'cheque' : 'cheques'}
                      </span>
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </Panel>

      <Panel scroll={{ maxH: '40vh' }}>
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
                <th scope="col" className="w-24">Matures</th>
                <th scope="col" className="w-24">Number</th>
                <th scope="col" className="w-28">Type</th>
                <th scope="col">Party</th>
                <th scope="col" className="w-28">Instrument</th>
                <th scope="col" className="r w-32">Amount</th>
                <th scope="col" className="w-52"></th>
              </tr>
            </thead>
            <tbody data-testid="rows-banking-pdc">
              {rows.map((r) => (
                <tr key={r.id} data-row-id={r.id} className="group hover:bg-panel2">
                  <td className="num text-muted">{toDisplayDate(r.date)}</td>
                  <td className="num">{r.number}</td>
                  <td className="text-muted">{r.voucherTypeName}</td>
                  <td className="max-w-52 truncate">{r.partyName ?? ''}</td>
                  <td className="num text-muted">{r.instrumentNo ?? ''}</td>
                  <td className="r"><Money paise={r.amount} /></td>
                  <td className="r">
                    <button
                      className="mr-3 text-small text-blue hover:underline"
                      data-testid="btn-banking-pdc-mature"
                      onClick={() => void mature(r.id, r.number)}
                    >
                      Mature now
                    </button>
                    {/* Quiet until the row is hovered, active or focused — a cheque coming back
                        is the rare case, and an always-lit "Bounced…" beside every row reads as
                        an instruction rather than an exception (#138). */}
                    <button
                      className="row-action mr-3 text-small text-muted hover:text-ink"
                      data-testid="btn-banking-pdc-bounce"
                      onClick={() => setBounceFor(r)}
                    >
                      Bounced…
                    </button>
                    <button
                      className="text-small text-muted hover:text-ink"
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

      <BouncedRegister />

      {bounceFor && (
        <BounceModal
          row={bounceFor}
          onClose={() => setBounceFor(null)}
          onDone={() => {
            setBounceFor(null)
            void refreshAfterBounce()
          }}
        />
      )}
    </>
  )
}

/**
 * Recording a returned cheque (#138).
 *
 * The charge is asked for on the same form as the bounce because it happened in the same event:
 * a return fee entered later as a separate payment is a fee nobody can tie back to the cheque
 * that caused it, which is exactly the trail this feature exists to leave.
 */
function BounceModal({
  row,
  onDone,
  onClose
}: {
  row: PdcRow
  onDone: () => void
  onClose: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const [bounceDate, setBounceDate] = useState(todayISO())
  const [reason, setReason] = useState('')
  const [chargeAmount, setChargeAmount] = useState<number | null>(null)
  const [chargeLedgerId, setChargeLedgerId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    if ((chargeAmount ?? 0) > 0 && chargeLedgerId == null) {
      return void toast.push('error', 'A return charge needs a ledger to post it to')
    }
    setSaving(true)
    try {
      await api.bounce.create({
        voucherId: row.id,
        bounceDate,
        reason: reason.trim() || null,
        chargeAmount: chargeAmount ?? 0,
        chargeLedgerId: (chargeAmount ?? 0) > 0 ? chargeLedgerId : null
      })
      toast.push('success', `${row.number} recorded as returned unpaid, and reversed`)
      onDone()
    } catch (err) {
      toast.push('error', (err as Error).message)
      setSaving(false)
    }
  }

  return (
    <Modal title={`Cheque returned — ${row.number}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-detail text-muted">
          {row.partyName ?? 'This voucher'}
          {row.instrumentNo ? ` · cheque ${row.instrumentNo}` : ''} ·{' '}
          <span className="num">{formatPaise(row.amount)}</span>. Recording the return posts a journal reversing every
          line of {row.number} and re-opens the bills it settled.
        </p>
        <Field label="Returned on" hint="Shorthand works: 7, 7/4, t (today), y (yesterday)">
          <DateInput value={bounceDate} context={row.date} onChange={setBounceDate} testId="input-bounce-date" className="w-40" />
        </Field>
        <Field label="Reason" hint="What the return memo said — “Funds insufficient”, “Signature differs”">
          <TextInput
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Funds insufficient"
            data-testid="input-bounce-reason"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bank's return charge" hint="Leave blank when the bank charged nothing">
            <AmountInput paise={chargeAmount} onPaise={setChargeAmount} testId="input-bounce-charge" className="w-40" />
          </Field>
          <Field label="Charge posted to">
            <LedgerPicker value={chargeLedgerId} onPick={setChargeLedgerId} testId="picker-bounce-charge-ledger" />
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={saving} data-testid="btn-bounce-save" onClick={() => void save()}>
            Record the return
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** Every cheque that came back, with the reversal it posted — and a way to undo one recorded
 *  against the wrong voucher (#138). */
function BouncedRegister(): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: bounces, isLoading } = useQuery({ queryKey: ['bounces'], queryFn: () => api.bounce.list() })

  const undo = async (id: number, number: string): Promise<void> => {
    const proceed = await confirmDialog({
      title: 'Undo bounce',
      message: `Remove the bounce recorded against ${number}? Its reversal journal goes to the bin and the receipt stands again.`,
      confirmLabel: 'Undo bounce'
    })
    if (!proceed) return
    try {
      await api.bounce.remove(id)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bounces'] }),
        queryClient.invalidateQueries({ queryKey: ['pdc'] }),
        queryClient.invalidateQueries({ queryKey: ['bankRecon'] }),
        queryClient.invalidateQueries({ queryKey: ['brs'] })
      ])
      toast.push('success', `Bounce on ${number} undone`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Panel className="mt-3">
      <div className="border-b border-line px-4 py-2.5">
        <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">
          Bounced cheques · {bounces?.length ?? 0}
        </p>
      </div>
      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Spinner />
        </div>
      ) : !bounces?.length ? (
        <EmptyState
          title="No bounced cheques"
          hint="Mark a receipt as returned from the register above — the reversal and the party's record are posted together"
        />
      ) : (
        <ScrollList maxH="32vh">
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-24">Returned</th>
                <th scope="col" className="w-24">Voucher</th>
                <th scope="col">Party</th>
                <th scope="col" className="w-28">Instrument</th>
                <th scope="col">Reason</th>
                <th scope="col" className="r w-32">Amount</th>
                <th scope="col" className="r w-28">Charge</th>
                <th scope="col" className="w-28">Reversal</th>
                <th scope="col" className="w-24"></th>
              </tr>
            </thead>
            <tbody data-testid="rows-banking-bounces">
              {bounces.map((b) => (
                <tr key={b.id} data-row-id={b.voucherId} className="group hover:bg-panel2">
                  <td className="num text-muted">{toDisplayDate(b.bounceDate)}</td>
                  <td className="num">{b.voucherNumber}</td>
                  <td className="max-w-52 truncate">{b.partyName ?? ''}</td>
                  <td className="num text-muted">{b.instrumentNo ?? ''}</td>
                  <td className="max-w-52 truncate text-muted">{b.reason ?? ''}</td>
                  <td className="r"><Money paise={b.amount} /></td>
                  <td className="r"><Money paise={b.chargeAmount} /></td>
                  <td className="num">
                    {b.reversalVoucherId != null ? (
                      <button
                        className="text-small text-blue hover:underline"
                        data-testid="btn-banking-bounce-reversal"
                        onClick={() => nav.go({ name: 'voucher-entry', voucherId: b.reversalVoucherId! })}
                      >
                        {b.reversalNumber ?? 'Open'}
                      </button>
                    ) : (
                      <span className="text-muted">–</span>
                    )}
                  </td>
                  <td className="r">
                    <button
                      className="row-action text-small text-muted hover:text-ink"
                      data-testid="btn-banking-bounce-undo"
                      onClick={() => void undo(b.id, b.voucherNumber)}
                    >
                      Undo
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollList>
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
                  <th scope="col">Pattern</th>
                  <th scope="col">Ledger</th>
                  <th scope="col" className="w-24">Kind</th>
                  <th scope="col" className="r w-16">Hits</th>
                  <th scope="col" className="w-16">Active</th>
                  <th scope="col" className="w-32"></th>
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
                      <button className="text-small text-blue hover:underline" onClick={() => void toggleActive(r)}>
                        {r.active ? 'Active' : 'Paused'}
                      </button>
                    </td>
                    <td className="r">
                      <button className="mr-3 text-small text-blue hover:underline" onClick={() => edit(r)}>
                        Edit
                      </button>
                      <button className="text-small text-cr hover:underline" onClick={() => void remove(r)}>
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
          <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">{editingId ? 'Edit rule' : 'Add rule'}</p>
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
              <label className="flex items-center gap-2 text-detail text-ink">
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
            <p className="text-detail text-cr">Couldn’t load the cheque layout: {(loadError as Error).message}</p>
            <Button data-testid="btn-banking-cheque-retry" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 py-4 text-detail text-muted">
            <Spinner /> Loading cheque layout…
          </div>
        )
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-4 gap-3">
            <MmField label="Cheque width (mm)" value={form.widthMm} onChange={(n) => setForm({ ...form, widthMm: n })} />
            <MmField label="Cheque height (mm)" value={form.heightMm} onChange={(n) => setForm({ ...form, heightMm: n })} />
            <div className="col-span-2 flex items-end pb-1.5">
              <label className="flex items-center gap-2 text-detail text-ink">
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
            <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Date boxes</p>
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
            <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Payee</p>
            <div className="grid grid-cols-4 gap-3">
              <MmField label="X (mm)" value={form.payee.xMm} onChange={(n) => setForm({ ...form, payee: { ...form.payee, xMm: n } })} />
              <MmField label="Y (mm)" value={form.payee.yMm} onChange={(n) => setForm({ ...form, payee: { ...form.payee, yMm: n } })} />
            </div>
          </div>

          <div>
            <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Amount in words</p>
            <div className="grid grid-cols-4 gap-3">
              <MmField label="X (mm)" value={form.words.xMm} onChange={(n) => setForm({ ...form, words: { ...form.words, xMm: n } })} />
              <MmField label="Y (mm)" value={form.words.yMm} onChange={(n) => setForm({ ...form, words: { ...form.words, yMm: n } })} />
              <MmField label="Width (mm)" value={form.words.wMm} onChange={(n) => setForm({ ...form, words: { ...form.words, wMm: n } })} />
            </div>
          </div>

          <div>
            <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Amount in figures</p>
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

/**
 * Where every bank account stands, on one page.
 *
 * The Reconcile tab answers this one account at a time and only once you have picked one, so a
 * business with four accounts has no way to see that three are current and one has not been
 * touched since June — which is exactly the account with the problem in it.
 */
function ReconciliationStatusPanel({ asOn }: { asOn: string }): React.JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ['reconStatus', asOn],
    queryFn: () => api.bank.reconciliationStatus(asOn)
  })
  const rows = data ?? []

  return (
    <>
      <Panel>
        {isLoading ? (
          <SkeletonRows rows={4} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No bank accounts yet"
            hint="Create a ledger under Bank Accounts to reconcile it here."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col" className="w-48">Reconciled</th>
                <th scope="col" className="r w-36">As per books</th>
                <th scope="col" className="r w-36">As per bank</th>
                <th scope="col" className="r w-28">Open items</th>
                <th scope="col" className="r w-28">Oldest</th>
                <th scope="col" className="w-28">Last cleared</th>
              </tr>
            </thead>
            <tbody data-testid="rows-recon-status">
              {rows.map((r) => {
                const pct = r.totalLines === 0 ? 1 : r.reconciledLines / r.totalLines
                const open = r.totalLines - r.reconciledLines
                return (
                  <tr key={r.ledgerId}>
                    <td>{r.name}</td>
                    <td>
                      {/* A bar rather than a percentage alone: four accounts side by side are
                          compared at a glance, and the one that is behind is the point. */}
                      <span className="flex items-center gap-2">
                        <span className="h-1.5 w-24 overflow-hidden rounded-full bg-line">
                          <span
                            className={`block h-full ${pct === 1 ? 'bg-dr' : pct >= 0.8 ? 'bg-amberbar' : 'bg-cr'}`}
                            style={{ width: `${Math.round(pct * 100)}%` }}
                          />
                        </span>
                        <span className="num text-hint text-muted" data-testid="recon-progress">
                          {r.reconciledLines}/{r.totalLines}
                        </span>
                      </span>
                    </td>
                    <td className="r"><Money paise={r.bookBalance} /></td>
                    <td className="r"><Money paise={r.bankBalance} /></td>
                    <td className="r num">{open || '–'}</td>
                    <td className={`r num ${r.oldestUnreconciledDays > 90 ? 'text-cr font-semibold' : 'text-muted'}`}>
                      {r.oldestUnreconciledDays ? `${r.oldestUnreconciledDays}d` : '–'}
                    </td>
                    <td className="num text-muted">
                      {r.lastReconciledDate ? toDisplayDate(r.lastReconciledDate) : 'never'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>
      {rows.some((r) => r.ageing[3] > 0) && (
        <div
          className="mt-3 rounded-md border border-amber/50 bg-amber/10 px-3.5 py-2.5 text-body-sm text-amber"
          data-testid="recon-stale"
        >
          {rows
            .filter((r) => r.ageing[3] > 0)
            .map((r) => `${r.name}: ${r.ageing[3]} entr${r.ageing[3] === 1 ? 'y' : 'ies'} over 90 days old`)
            .join(' · ')}
          . An entry that has not cleared in three months usually never will.
        </div>
      )}
      <p className="mt-2 text-hint text-muted">
        As on {toDisplayDate(asOn)}. An entry cleared after that date was still outstanding on it,
        so it counts as open here — the same rule the BRS uses.
      </p>
    </>
  )
}

/** Field labels for the column mapper — the user's words, not the engine's keys. */
const FIELD_LABELS: Record<ProfileField, string> = {
  date: 'Date',
  narration: 'Narration',
  reference: 'Cheque / reference',
  debit: 'Withdrawal (debit)',
  credit: 'Deposit (credit)',
  amount: 'Amount',
  drCr: 'Dr/Cr indicator',
  balance: 'Balance'
}

/**
 * Map a statement nobody recognises (#131).
 *
 * The failure this replaces was an error toast: a bank the app had never seen simply would not
 * import, and there was nothing the user could do about it. Here the header row is on screen, the
 * best guess is pre-filled, and the count of rows the mapping actually reads updates as the user
 * changes it — so "did I get this right" is answered before anything is imported, not after.
 */
function ColumnMappingModal({
  inspection,
  onUse,
  onClose
}: {
  inspection: BankStatementInspection
  onUse: (choice: ProfileChoice) => void
  onClose: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: profiles } = useQuery({ queryKey: ['bankImportProfiles'], queryFn: api.bankProfiles.list })
  const [columns, setColumns] = useState<BankProfileColumns>(
    inspection.columns ?? { date: inspection.header[0] ?? '', narration: '' }
  )
  const [dateFormat, setDateFormat] = useState(inspection.dateFormat)
  const [convention, setConvention] = useState(inspection.convention)
  const [debitFlag, setDebitFlag] = useState(inspection.debitFlag ?? 'DR')
  const [saveAs, setSaveAs] = useState('')
  const [saving, setSaving] = useState(false)

  const adHoc: BankAdHocProfile = { dateFormat, convention, debitFlag: debitFlag || null, columns }

  // Re-read the file on every change: the answer to "will this work" is the file itself, and it
  // is cheap enough to compute that showing anything less would be a choice.
  const { data: trial } = useQuery({
    queryKey: ['bankStatementInspect', inspection.csvText.length, JSON.stringify(adHoc)],
    queryFn: () => api.bank.inspectStatement({ csvText: inspection.csvText, adHoc })
  })

  const setField = (field: ProfileField, value: string): void =>
    setColumns((c) => ({ ...c, [field]: value === '' ? null : value }))

  const usePicked = (profileId: string): void => {
    const found = (profiles ?? []).find((p) => p.id === profileId)
    if (!found) return
    setColumns(found.columns)
    setDateFormat(found.dateFormat)
    setConvention(found.convention)
    setDebitFlag(found.debitFlag ?? 'DR')
  }

  const saveProfile = async (): Promise<void> => {
    if (saveAs.trim().length < 2) return void toast.push('error', 'Give the profile a name')
    setSaving(true)
    try {
      const saved = await api.bankProfiles.save({ ...adHoc, name: saveAs.trim() })
      await queryClient.invalidateQueries({ queryKey: ['bankImportProfiles'] })
      toast.push('success', `Saved as “${saved.name}” — next month's file is recognised on sight`)
      onUse({ profileId: saved.id })
    } catch (err) {
      toast.push('error', (err as Error).message)
      setSaving(false)
    }
  }

  // Which fields are worth showing depends on how the file expresses direction — offering a
  // Dr/Cr column on a two-column statement is just noise to read past.
  const shown: ProfileField[] = PROFILE_FIELDS.filter((f) => {
    if (f === 'debit' || f === 'credit') return convention === 'debit_credit'
    if (f === 'amount') return convention !== 'debit_credit'
    if (f === 'drCr') return convention === 'flagged'
    return true
  })

  return (
    <Modal title="Which column is which?" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <p className="text-detail text-muted">
          {inspection.error ?? `Read with ${inspection.profileName ?? 'no profile'}`}. Point each field at a column
          from your file; the count below says what that mapping actually reads.
        </p>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Start from">
            <Select defaultValue="" onChange={(e) => usePicked(e.target.value)} data-testid="select-banking-profile">
              <option value="">Pick a bank…</option>
              {(profiles ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Dates are written">
            <Select value={dateFormat} onChange={(e) => setDateFormat(e.target.value as typeof dateFormat)} data-testid="select-banking-dateformat">
              <option value="dmy">Day/Month/Year — 03/04/2026 is 3 April</option>
              <option value="mdy">Month/Day/Year — 03/04/2026 is 4 March</option>
              <option value="ymd">Year/Month/Day</option>
            </Select>
          </Field>
          <Field label="Direction is">
            <Select value={convention} onChange={(e) => setConvention(e.target.value as typeof convention)} data-testid="select-banking-convention">
              <option value="debit_credit">Two columns (withdrawal / deposit)</option>
              <option value="signed">One amount, negative is money out</option>
              <option value="flagged">One amount plus a Dr/Cr column</option>
            </Select>
          </Field>
        </div>

        <div className="grid grid-cols-4 gap-3">
          {shown.map((field) => (
            <Field key={field} label={FIELD_LABELS[field]}>
              <Select
                value={(columns[field] as string | null | undefined) ?? ''}
                onChange={(e) => setField(field, e.target.value)}
                data-testid={`select-banking-col-${field}`}
              >
                <option value="">— none —</option>
                {inspection.header.map((h, i) => (
                  <option key={`${h}-${i}`} value={h}>{h || `(column ${i + 1})`}</option>
                ))}
              </Select>
            </Field>
          ))}
          {convention === 'flagged' && (
            <Field label="Withdrawal is marked">
              <TextInput value={debitFlag} onChange={(e) => setDebitFlag(e.target.value)} placeholder="DR" />
            </Field>
          )}
        </div>

        <div className="rounded-md border border-line">
          <p className="border-b border-line px-3.5 py-2 text-detail" data-testid="banking-mapping-count">
            {trial?.error
              ? <span className="text-cr">{trial.error}</span>
              : <>Reads <span className="num font-medium text-ink">{trial?.rowsReadable ?? 0}</span> rows
                  {(trial?.rowsSkipped ?? 0) > 0 && <span className="text-muted"> · skips {trial!.rowsSkipped}</span>}</>}
          </p>
          {(trial?.sample.length ?? 0) > 0 && (
            <table className="ledger-table">
              <thead>
                <tr>
                  <th scope="col" className="w-24">Date</th>
                  <th scope="col">Description</th>
                  <th scope="col" className="r w-32">Deposit</th>
                  <th scope="col" className="r w-32">Withdrawal</th>
                </tr>
              </thead>
              <tbody data-testid="rows-banking-mapping-sample">
                {trial!.sample.map((r, i) => (
                  <tr key={i}>
                    <td className="num w-24 text-muted">{toDisplayDate(r.date)}</td>
                    <td className="max-w-80 truncate">{r.description}</td>
                    <td className="num r w-32"><Money paise={r.deposit} /></td>
                    <td className="num r w-32"><Money paise={r.withdrawal} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-end justify-between gap-2 border-t border-line pt-4">
          <div className="flex items-end gap-2">
            <Field label="Remember this as">
              <TextInput value={saveAs} onChange={(e) => setSaveAs(e.target.value)} placeholder="e.g. Saraswat Co-op" className="w-56" />
            </Field>
            <Button disabled={saving || !saveAs.trim()} data-testid="btn-banking-save-profile" onClick={() => void saveProfile()}>
              Save profile &amp; use
            </Button>
          </div>
          <span className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!trial || trial.rowsReadable === 0}
              data-testid="btn-banking-use-mapping"
              onClick={() => onUse({ adHoc })}
            >
              Use these columns
            </Button>
          </span>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Confirmation for bulk accept (#134): the count, the money, and the rows themselves.
 *
 * Filing twenty vouchers is not something to do on the strength of a number alone, so the rows
 * are listed with the ledger and the confidence each was accepted at — and the same pass that
 * produced this list is the one that will do the work.
 */
function BulkAcceptModal({
  preview,
  onApply,
  onClose
}: {
  preview: BankBulkAcceptResult
  onApply: () => void
  onClose: () => void
}): React.JSX.Element {
  const [applying, setApplying] = useState(false)
  return (
    <Modal title={`Accept ${preview.count} high-confidence ${preview.count === 1 ? 'match' : 'matches'}`} onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-3">
          <Panel className="px-4 py-2.5">
            <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Will file</p>
            <p className="num mt-1 text-lead font-medium" data-testid="banking-bulk-count">{preview.count}</p>
          </Panel>
          <Panel className="px-4 py-2.5">
            <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Payments</p>
            <p className="num mt-1 text-lead font-medium"><Money paise={preview.withdrawalTotal} /></p>
          </Panel>
          <Panel className="px-4 py-2.5">
            <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Receipts</p>
            <p className="num mt-1 text-lead font-medium"><Money paise={preview.depositTotal} /></p>
          </Panel>
        </div>

        <ScrollList maxH="34vh" className="rounded-md border border-line">
          <table className="ledger-table">
            <tbody data-testid="rows-banking-bulk-accept">
              {preview.accepted.map((a, i) => (
                <tr key={i}>
                  <td className="num w-24 text-muted">{toDisplayDate(a.date)}</td>
                  <td className="max-w-72 truncate">{a.description}</td>
                  <td className="w-48 truncate">{a.ledgerName}</td>
                  <td className="num r w-20 text-muted">{a.confidence}%</td>
                  <td className="num r w-32"><Money paise={a.amount} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollList>

        <p className="text-hint text-muted">
          At or above {preview.minConfidence}%. {preview.skipped} other {preview.skipped === 1 ? 'suggestion stays' : 'suggestions stay'} untouched —
          anything below the bar, and anything where two ledgers fit the wording equally well.
        </p>

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={applying || preview.count === 0}
            data-testid="btn-banking-bulk-apply"
            onClick={() => {
              setApplying(true)
              onApply()
            }}
          >
            {preview.count === 0 ? 'Nothing to accept' : `File ${preview.count} ${preview.count === 1 ? 'voucher' : 'vouchers'}`}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Create or edit the rule for one unmatched row, from that row (#147).
 *
 * Writing a rule used to mean leaving the line you were looking at, opening the rules list, and
 * retyping the narration from memory. Here the row is the context: the pattern is suggested from
 * its own narration, the direction is fixed by which way the money went, and an existing rule
 * that already fired is edited rather than competed with.
 */
function InlineRuleModal({
  row,
  ruleId,
  suggestedLedgerId,
  onSaved,
  onClose
}: {
  row: BankUnmatchedRow
  ruleId: number | null
  suggestedLedgerId: number | null
  onSaved: () => void
  onClose: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: rules } = useQuery({ queryKey: ['bankRules'], queryFn: api.bankRules.list })
  const existing = ruleId != null ? rules?.find((r) => r.id === ruleId) : undefined
  // Direction is not a choice: a withdrawal cannot be a receipt rule, and offering the option
  // only invites a rule that can never fire.
  const kind: 'payment' | 'receipt' = row.kind === 'deposit' ? 'receipt' : 'payment'

  const [pattern, setPattern] = useState(existing?.pattern ?? suggestPattern(row.description))
  const [ledgerId, setLedgerId] = useState<number | null>(existing?.ledgerId ?? suggestedLedgerId)
  const [active, setActive] = useState(existing?.active ?? true)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(existing != null)

  // The rule list arrives after the modal opens; fill the form from it once, without stomping on
  // anything the user has already typed.
  useEffect(() => {
    if (loaded || !existing) return
    setPattern(existing.pattern)
    setLedgerId(existing.ledgerId)
    setActive(existing.active)
    setLoaded(true)
  }, [existing, loaded])

  const matches = pattern.trim() !== '' && row.description.toLowerCase().includes(pattern.trim().toLowerCase())

  const save = async (): Promise<void> => {
    if (pattern.trim().length < 2) return void toast.push('error', 'Pattern needs at least 2 characters')
    if (ledgerId == null) return void toast.push('error', 'Pick a ledger')
    setSaving(true)
    try {
      await api.bankRules.save({ pattern: pattern.trim(), ledgerId, kind, active }, ruleId ?? undefined)
      // Writing a rule for a narration is the user saying what it means, so it teaches the
      // narration memory too — the two halves of #133 and #147 are the same statement.
      await api.bank.learn(row.description, ledgerId, kind)
      await queryClient.invalidateQueries({ queryKey: ['bankRules'] })
      toast.push('success', ruleId ? 'Rule updated' : 'Rule created')
      onSaved()
    } catch (err) {
      toast.push('error', (err as Error).message)
      setSaving(false)
    }
  }

  return (
    <Modal title={ruleId ? 'Edit the rule for this line' : 'Rule from this line'} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="rounded-md border border-line px-3.5 py-2">
          <p className="text-detail text-ink">{row.description}</p>
          <p className="mt-0.5 text-hint text-muted">
            {toDisplayDate(row.date)} · {row.kind} · <Money paise={row.amount} />
          </p>
        </div>

        <Field
          label="Match when the narration contains"
          hint={matches ? 'Matches this line' : 'Does not match this line — the rule will not fire on it'}
        >
          <TextInput autoFocus value={pattern} onChange={(e) => setPattern(e.target.value)} data-testid="input-banking-inline-pattern" />
        </Field>
        <Field label={kind === 'payment' ? 'Post the payment to' : 'Post the receipt to'}>
          <LedgerPicker value={ledgerId} onPick={setLedgerId} placeholder="Ledger" />
        </Field>
        <label className="flex items-center gap-2 text-detail text-ink">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving} data-testid="btn-banking-inline-rule-save" onClick={() => void save()}>
            {ruleId ? 'Save rule' : 'Create rule'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
