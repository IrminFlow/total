import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fyFromStartYear, fyOf, todayISO, toDisplayDate } from '@shared/dates'
import { planClose, type CloseLedgerRow } from '@shared/yearEnd'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { CashFinanceCloseWarnings } from './cashFinance/CloseWarnings'
import { Banner, Button, DrawerSection, EmptyState, Money, Page, PageHeader, Panel, Select, TextInput } from '../components/ui'
import { OptionsTable } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { LedgerLink } from '../components/links'
import { isRealId, openLedgerStatement } from '../lib/drill'

type Step = 1 | 2 | 3

const NATURE_OPTIONS = [
  { value: 'income', label: 'Income' },
  { value: 'expense', label: 'Expense' }
]

export const PNL_COLUMNS = defineColumns<CloseLedgerRow>([
  {
    id: 'ledger',
    header: 'Ledger',
    kind: 'text',
    value: (r) => r.name,
    hideable: false,
    groupable: false,
    cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.name} />
  },
  { id: 'nature', header: 'Nature', kind: 'enum', value: (r) => r.nature, options: NATURE_OPTIONS, className: 'text-muted', width: 110 },
  // Net movement for the FY (dr-positive) — a period figure, so the footer nets it to the P&L result.
  { id: 'balance', header: 'Balance', kind: 'money', signed: true, value: (r) => r.net, width: 170, aggregate: 'sum' }
])

interface JournalRow {
  /** null = the Retained Earnings line (resolved by the close service). */
  ledgerId: number | null
  name: string
  debit: number | null
  credit: number | null
}

const JOURNAL_COLUMNS = defineColumns<JournalRow>([
  {
    id: 'ledger',
    header: 'Ledger',
    kind: 'text',
    value: (r) => r.name,
    hideable: false,
    groupable: false,
    cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.name} />
  },
  { id: 'debit', header: 'Debit', kind: 'money', value: (r) => r.debit, width: 140, aggregate: 'sum' },
  { id: 'credit', header: 'Credit', kind: 'money', value: (r) => r.credit, width: 140, aggregate: 'sum' }
])

export function YearEndScreen(): React.JSX.Element {
  const { info, setPeriod } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()

  const currentFy = fyOf(todayISO())
  // Only completed FYs are closeable — the running FY isn't over yet, so it never appears here.
  const lastCompletedStartYear = currentFy.startYear - 1
  const years: number[] = []
  for (let y = lastCompletedStartYear; y >= (info?.booksFrom ?? lastCompletedStartYear); y--) years.push(y)
  const noCompletedFy = years.length === 0

  const [fyStartYear, setFyStartYear] = useState(years[0] ?? lastCompletedStartYear)
  const [step, setStep] = useState<Step>(1)
  const [confirmText, setConfirmText] = useState('')
  const [posting, setPosting] = useState(false)
  const [result, setResult] = useState<{ voucherId: number; netProfit: number; lockedUpTo: string } | null>(null)

  const fy = fyFromStartYear(fyStartYear)

  const { data: preview, isLoading } = useQuery({
    queryKey: ['yearEndPreview', fyStartYear],
    queryFn: () => api.yearEnd.preview(fyStartYear),
    enabled: !noCompletedFy
  })

  // Income first, then expense — the order the review has always shown.
  const pnlRows = useMemo(() => {
    const rows = preview?.rows ?? []
    return [...rows.filter((r) => r.nature === 'income'), ...rows.filter((r) => r.nature === 'expense')]
  }, [preview])

  const plan = useMemo(() => (preview ? planClose(preview.rows) : { lines: [], netProfit: 0 }), [preview])
  const journalRows = useMemo<JournalRow[]>(() => {
    const names = new Map((preview?.rows ?? []).map((r) => [r.ledgerId, r.name]))
    const rows: JournalRow[] = plan.lines.map((l) => ({
      ledgerId: l.ledgerId,
      name: names.get(l.ledgerId) ?? '',
      debit: l.drCr === 'dr' ? l.amount : null,
      credit: l.drCr === 'cr' ? l.amount : null
    }))
    if (plan.netProfit !== 0) {
      const amount = Math.abs(plan.netProfit)
      rows.push({ ledgerId: null, name: 'Retained Earnings', debit: plan.netProfit < 0 ? amount : null, credit: plan.netProfit > 0 ? amount : null })
    }
    return rows
  }, [plan, preview])

  const changeYear = (y: number): void => {
    setFyStartYear(y)
    setStep(1)
    setConfirmText('')
    setResult(null)
  }

  const post = async (): Promise<void> => {
    if (posting || !preview) return
    setPosting(true)
    try {
      // The P&L may have moved since step 2 (another voucher posted in the meantime) — re-check
      // right before posting rather than trust a stale preview.
      const fresh = await api.yearEnd.preview(fyStartYear)
      if (fresh.netProfit !== preview.netProfit || fresh.alreadyClosed) {
        toast.push('error', 'The P&L changed since you reviewed it — recheck before closing.')
        await queryClient.invalidateQueries({ queryKey: ['yearEndPreview', fyStartYear] })
        setStep(1)
        return
      }
      const r = await api.yearEnd.close(fyStartYear)
      setResult(r)
      const nextFy = fyFromStartYear(fyStartYear + 1)
      setPeriod(nextFy.from, nextFy.to)
      await queryClient.invalidateQueries()
      toast.push('success', `FY ${fy.label} closed — books locked up to ${toDisplayDate(r.lockedUpTo)}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setPosting(false)
    }
  }

  if (noCompletedFy) {
    return (
      <Page width="narrow">
        <PageHeader title="Year-end close" />
        <Panel>
          <EmptyState
            title="The first financial year is still in progress"
            hint={`Come back after 31 Mar ${currentFy.startYear + 1}`}
          />
        </Panel>
      </Page>
    )
  }

  if (result) {
    return (
      <Page width="narrow">
        <PageHeader title="Year-end close" />
        <Panel className="p-6 text-center">
          <p className="text-subtitle font-medium">FY {fy.label} closed</p>
          <p className="mt-1 text-detail text-muted">
            {result.netProfit >= 0 ? 'Net profit' : 'Net loss'} of <Money paise={Math.abs(result.netProfit)} /> carried to Retained
            Earnings. Books are locked up to {toDisplayDate(result.lockedUpTo)}.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Button variant="primary" onClick={() => nav.go({ name: 'voucher-entry', voucherId: result.voucherId })}>
              Open closing voucher
            </Button>
            <Button
              onClick={() => {
                setResult(null)
                changeYear(Math.min(fyStartYear + 1, lastCompletedStartYear))
              }}
            >
              Done
            </Button>
          </div>
        </Panel>
      </Page>
    )
  }

  return (
    <Page>
      <PageHeader
        title="Year-end close"
        controls={
          <Select value={fyStartYear} onChange={(e) => changeYear(Number(e.target.value))} className="w-36" aria-label="Financial year" data-testid="input-year-end-fy">
            {years.map((y) => (
              <option key={y} value={y}>
                FY {fyFromStartYear(y).label}
              </option>
            ))}
          </Select>
        }
        options={{
          content: (
            <>
              {step === 1 && <OptionsTable area="year-end-pnl" label="P&L review table" />}
              {step === 2 && <OptionsTable area="year-end-journal" label="Closing journal table" />}
              <DrawerSection title="About the close">
                <p className="text-hint text-muted">
                  Closing posts one journal that carries the year&apos;s net profit or loss to Retained Earnings and locks the
                  books up to the year&apos;s last day.
                </p>
              </DrawerSection>
            </>
          )
        }}
      />

      <ol className="mb-section flex items-center gap-2 text-small font-medium text-muted" aria-label="Steps">
        <StepDot n={1} step={step} label="Review P&L" />
        <li aria-hidden="true" className="text-line">—</li>
        <StepDot n={2} step={step} label="Closing journal" />
        <li aria-hidden="true" className="text-line">—</li>
        <StepDot n={3} step={step} label="Confirm" />
      </ol>

      {preview?.alreadyClosed && (
        <Banner tone="danger" className="mb-section" title={`Books for FY ${fy.label} are already closed.`}>
          Pick a different financial year to continue, or open the closing voucher from the day book.
        </Banner>
      )}

      {preview?.depreciation?.missing && !preview.alreadyClosed && (
        <Banner
          tone="warning"
          className="mb-section"
          testId="year-end-depreciation-missing"
          title={`Depreciation for FY ${fy.label} has not been run${preview.depreciation.coveredThrough ? ` past ${toDisplayDate(preview.depreciation.coveredThrough)}` : ''}.`}
          action={
            <Button size="sm" data-testid="btn-year-end-run-depreciation" onClick={() => nav.go({ name: 'fixed-assets', tab: 'depreciation' })}>
              Run depreciation
            </Button>
          }
        >
          {preview.depreciation.assetsInService} fixed asset{preview.depreciation.assetsInService === 1 ? ' is' : 's are'} in service. Closing now
          leaves the year&apos;s depreciation out of its profit.
        </Banner>
      )}

      {/* WP 2.5d (design §9 Q5): goods received / delivered but not invoiced on 31 March — warn, no journal. */}
      {preview?.unbilled && !preview.alreadyClosed && (preview.unbilled.grni.value > 0 || preview.unbilled.gdni.value > 0) && (
        <Banner
          tone="warning"
          className="mb-section"
          testId="year-end-unbilled"
          title={`Goods not invoiced on ${toDisplayDate(preview.unbilled.asOn)}`}
          action={
            <Button size="sm" data-testid="btn-year-end-unbilled" onClick={() => nav.go({ name: 'unbilled-goods' })}>
              See GRNI / GDNI
            </Button>
          }
        >
          {preview.unbilled.grni.value > 0 && (
            <>
              Received, not billed (GRNI) <Money paise={preview.unbilled.grni.value} /> on {preview.unbilled.grni.notes} GRN
              {preview.unbilled.grni.notes === 1 ? '' : 's'}: in closing stock with no purchase booked.{' '}
            </>
          )}
          {preview.unbilled.gdni.value > 0 && (
            <>
              Delivered, not invoiced (GDNI) <Money paise={preview.unbilled.gdni.value} /> on {preview.unbilled.gdni.notes} challan
              {preview.unbilled.gdni.notes === 1 ? '' : 's'}: out of stock with no sale booked.{' '}
            </>
          )}
          Nothing is posted for these automatically — book a provision if your CA asks for one, or bill / invoice them before closing.
        </Banner>
      )}

      {/* WP 4.4: unposted EMIs, unrevalued forex balances, over-budget departments (warn-only). */}
      <CashFinanceCloseWarnings fyStartYear={fyStartYear} closed={!!preview?.alreadyClosed} />

      {step === 1 && (
        <>
          <Panel className="mb-section">
            <DataTable
              viewId="year-end-pnl"
              testId="year-end-pnl"
              ariaLabel={`Income and expense ledgers for FY ${fy.label}`}
              columns={PNL_COLUMNS}
              rows={pnlRows}
              rowKey={(r) => r.ledgerId}
              rowAttrs={(r) => ({ 'data-row-id': r.ledgerId })}
              loading={isLoading}
              maxHeight="55vh"
              totalsLabel="Net"
              onRowActivate={(r) => nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })}
              empty={{ title: 'No income or expense activity in this FY', hint: 'Nothing to close for this period' }}
              exportOptions={{ title: 'Year-end close — P&L review', periodLabel: `FY ${fy.label}`, filename: `year-end-pnl-${fy.label}`, totalsLabel: 'Net' }}
            />
          </Panel>
          {preview && (
            <Panel className="mb-section flex items-center justify-between px-5 py-3">
              <span className="text-body font-medium">{preview.netProfit >= 0 ? 'Net profit for FY' : 'Net loss for FY'} {fy.label}</span>
              <Money
                paise={Math.abs(preview.netProfit)}
                className={`text-title font-semibold ${preview.netProfit >= 0 ? 'text-dr' : 'text-cr'}`}
              />
            </Panel>
          )}
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={!preview || preview.alreadyClosed || pnlRows.length === 0}
              onClick={() => setStep(2)}
            >
              Next: review journal
            </Button>
          </div>
        </>
      )}

      {step === 2 && preview && (
        <>
          <Panel className="mb-section">
            <div className="border-b border-line px-4 py-2.5 text-body-sm text-muted">
              Journal · dated {toDisplayDate(fy.to)} · narration “Year-end closing entry [year-end close FY{fyStartYear}]”
            </div>
            <DataTable
              viewId="year-end-journal"
              testId="year-end-journal"
              ariaLabel="Closing journal"
              columns={JOURNAL_COLUMNS}
              rows={journalRows}
              rowKey={(r) => r.ledgerId ?? 'retained'}
              isRowActivatable={(r) => isRealId(r.ledgerId)}
              onRowActivate={(r) => openLedgerStatement(r.ledgerId!)}
              rowClassName={(r) => (r.ledgerId == null ? 'bg-amberbar/10 font-medium' : '')}
              maxHeight="50vh"
              exportOptions={{
                title: `Year-end closing journal — FY ${fy.label}`,
                periodLabel: `dated ${toDisplayDate(fy.to)}`,
                filename: `year-end-journal-${fy.label}`
              }}
            />
          </Panel>
          <Panel className="mb-section border-warning/40 bg-warning-soft p-4">
            <p className="text-detail font-medium">
              Posting will lock all entries up to {toDisplayDate(fy.to)}.
            </p>
            <p className="mt-1 text-body-sm text-muted">
              This cannot be undone from this wizard — an owner can adjust the lock date later from Settings → About.
            </p>
          </Panel>
          <div className="flex justify-between">
            <Button onClick={() => setStep(1)}>Back</Button>
            <Button variant="primary" onClick={() => setStep(3)}>
              Next: confirm
            </Button>
          </div>
        </>
      )}

      {step === 3 && preview && (
        <>
          <Panel className="mb-section p-5">
            <p className="text-body">
              Closing FY {fy.label} will post the journal above and lock the books up to {toDisplayDate(fy.to)}. Type{' '}
              <span className="font-mono font-semibold">CLOSE</span> to confirm.
            </p>
            <div className="mt-3 max-w-xs">
              <TextInput
                data-testid="input-year-end-confirm"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="CLOSE"
                autoFocus
              />
              {confirmText !== '' && confirmText !== 'CLOSE' && (
                <p data-testid="year-end-confirm-error" className="mt-1.5 text-small text-cr">
                  Type CLOSE exactly (all caps) to enable the button.
                </p>
              )}
            </div>
          </Panel>
          <div className="flex justify-between">
            <Button onClick={() => setStep(2)}>Back</Button>
            <Button variant="primary" data-testid="btn-year-end-post" disabled={confirmText !== 'CLOSE' || posting} onClick={() => void post()}>
              {posting ? 'Posting…' : 'Post closing entry & lock'}
            </Button>
          </div>
        </>
      )}
    </Page>
  )
}

function StepDot({ n, step, label }: { n: Step; step: Step; label: string }): React.JSX.Element {
  const active = n === step
  const done = n < step
  return (
    <li aria-current={active ? 'step' : undefined} className={`flex items-center gap-1.5 ${active ? 'text-ink' : done ? 'text-dr' : ''}`}>
      <span
        className={`flex h-4 w-4 items-center justify-center rounded-full text-micro ${
          active ? 'bg-amberbar text-on-amber' : done ? 'bg-dr/20 text-dr' : 'bg-panel2 text-muted'
        }`}
      >
        {n}
      </span>
      {label}
    </li>
  )
}
