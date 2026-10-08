// Budgets (task 2.6, extended in WP 4.4): targets by ledger or group, optionally per cost centre
// (department), spread over the year evenly, by a seasonal profile or by hand; variance for the
// selected month and the year to date with favourable / unfavourable colouring, a month-by-month
// view, drill-down to the vouchers behind an actual, revision history and CSV import / export.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Budget } from '@shared/domain'
import type { BudgetLineInput } from '@shared/schemas'
import type { BudgetDrillRow, BudgetRevision } from '@shared/cashFinance'
import { fyMonthList, PHASING_LABELS, phaseByWeights, type BudgetPhasing, type Figure, type MonthlyVarianceRow } from '@shared/budgetPhasing'
import { fyFromStartYear, fyOf, todayISO, toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { api } from '../lib/client'
import { cfApi } from '../lib/cashFinanceClient'
import { useToasts } from '../state/stores'
import {
  AmountInput, Banner, Button, Drawer, EmptyState, Field, Modal, Page, PageHeader, Panel, ScrollList, SectionTitle, Segmented, Select, TextInput, SkeletonRows
} from '../components/ui'
import { OptionsTable } from '../components/ScreenOptions'
import { DrawerSection } from '../components/kit/Drawer'
import { DataTable, defineColumns } from '../components/table'
import { LedgerPicker, useGroups } from '../components/pickers'
import { confirmDialog, promptDialog } from '../lib/dialogs'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'
import { LedgerLink, VoucherLink } from '../components/links'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return `${MONTH_NAMES[m - 1]} ${y}`
}

/** Variance text with direction and verdict: "+1,200.00 over" / "−300.00 under" / "–". */
export function varianceText(f: Figure): string {
  if (f.variance == null) return '—'
  if (f.variance === 0) return '–'
  return `${f.variance > 0 ? '+' : '−'}${formatPaise(Math.abs(f.variance))} ${f.variance > 0 ? 'over' : 'under'}`
}

function VarianceCell({ f }: { f: Figure }): React.JSX.Element {
  if (f.variance == null) return <span className="text-muted">—</span>
  if (f.variance === 0) return <span className="num text-muted">–</span>
  const tone = f.favourable == null ? 'text-muted' : f.favourable ? 'text-dr' : 'text-cr'
  return (
    <span className={`num ${tone}`} data-favourable={f.favourable == null ? undefined : String(f.favourable)}>
      {f.variance > 0 ? '+' : '−'}
      {formatPaise(Math.abs(f.variance))}
      <span className="ml-1 text-caption">{f.favourable ? 'fav' : 'adv'}</span>
    </span>
  )
}

const pctText = (f: Figure): string => (f.pct == null ? '—' : `${f.pct}%`)
const budgetCell = (f: Figure): React.JSX.Element => (f.budget == null ? <span className="text-muted">—</span> : <span className="num">{formatPaise(f.budget)}</span>)

const spreadLabel = (r: Pick<MonthlyVarianceRow, 'month' | 'phasing'>): string => (r.month ? monthLabel(r.month) : PHASING_LABELS[r.phasing])

function summaryColumns(monthTitle: string) {
  return defineColumns<MonthlyVarianceRow>([
    {
      id: 'target', header: 'Target', kind: 'text', value: (v) => v.targetName, hideable: false, minWidth: 160,
      cell: (v) => (v.ledgerId != null ? <LedgerLink ledgerId={v.ledgerId} name={v.targetName} /> : <span>{v.targetName}</span>)
    },
    { id: 'cc', header: 'Cost centre', kind: 'text', value: (v) => v.costCentreName ?? '', width: 120, className: 'text-muted' },
    { id: 'spread', header: 'Spread', kind: 'text', value: (v) => spreadLabel(v), width: 150, className: 'text-muted', defaultHidden: true },
    { id: 'annual', header: 'Annual budget', kind: 'money', value: (v) => v.annualBudget, width: 130, defaultHidden: true },
    { id: 'mBudget', header: 'Budget', group: monthTitle, kind: 'money', value: (v) => v.current.budget, width: 118, cell: (v) => budgetCell(v.current) },
    { id: 'mActual', header: 'Actual', group: monthTitle, kind: 'money', value: (v) => v.current.actual, width: 118 },
    { id: 'mVar', header: 'Variance', group: monthTitle, kind: 'money', value: (v) => v.current.variance, text: (v) => varianceText(v.current), cell: (v) => <VarianceCell f={v.current} />, width: 150 },
    { id: 'mPct', header: '%', group: monthTitle, kind: 'number', value: (v) => v.current.pct, text: (v) => pctText(v.current), width: 64, className: 'text-muted' },
    { id: 'yBudget', header: 'Budget', group: 'Year to date', kind: 'money', value: (v) => v.ytd.budget, width: 124 },
    { id: 'yActual', header: 'Actual', group: 'Year to date', kind: 'money', value: (v) => v.ytd.actual, width: 124 },
    { id: 'yVar', header: 'Variance', group: 'Year to date', kind: 'money', value: (v) => v.ytd.variance, text: (v) => varianceText(v.ytd), cell: (v) => <VarianceCell f={v.ytd} />, width: 150 },
    { id: 'yPct', header: '%', group: 'Year to date', kind: 'number', value: (v) => v.ytd.pct, text: (v) => pctText(v.ytd), width: 64, className: 'text-muted' }
  ])
}

function monthColumns(months: string[], upToMonth: string) {
  const upIdx = months.indexOf(upToMonth)
  return defineColumns<MonthlyVarianceRow>([
    { id: 'target', header: 'Target', kind: 'text', value: (v) => v.targetName, hideable: false, minWidth: 150 },
    { id: 'cc', header: 'Cost centre', kind: 'text', value: (v) => v.costCentreName ?? '', width: 110, className: 'text-muted' },
    ...months.map((m, i) => ({
      id: `m${i}`, header: MONTH_NAMES[Number(m.slice(5, 7)) - 1]!, kind: 'money' as const, value: (v: MonthlyVarianceRow) => v.months[i]!.actual,
      text: (v: MonthlyVarianceRow) => `${formatPaise(v.months[i]!.actual)} / ${v.months[i]!.budget == null ? '—' : formatPaise(v.months[i]!.budget!)}`,
      width: 104,
      cell: (v: MonthlyVarianceRow) => {
        const f = v.months[i]!
        // Months after the selected one haven't happened yet: no verdict.
        const tone = upIdx >= 0 && i > upIdx ? 'text-muted' : f.favourable == null ? 'text-ink' : f.favourable ? 'text-dr' : 'text-cr'
        return (
          <span className="flex flex-col items-end leading-tight" title={`Budget ${f.budget == null ? '—' : formatPaise(f.budget)}`}>
            <span className={`num ${tone}`}>{formatPaise(f.actual)}</span>
            <span className="num text-caption text-muted">{f.budget == null ? '—' : formatPaise(f.budget)}</span>
          </span>
        )
      }
    })),
    { id: 'yVar', header: 'YTD variance', kind: 'money', value: (v) => v.ytd.variance, text: (v) => varianceText(v.ytd), cell: (v) => <VarianceCell f={v.ytd} />, width: 150 }
  ])
}

const DRILL_COLUMNS = defineColumns<BudgetDrillRow>([
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, width: 100 },
  { id: 'number', header: 'No.', kind: 'text', value: (r) => r.number, width: 100, cell: (r) => <VoucherLink voucherId={r.voucherId} label={r.number} /> },
  { id: 'type', header: 'Type', kind: 'text', value: (r) => r.voucherType, width: 100, className: 'text-muted' },
  { id: 'ledger', header: 'Ledger', kind: 'text', value: (r) => r.ledgerName, minWidth: 140, cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.ledgerName} /> },
  { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.amount, aggregate: 'sum', width: 124 }
])

const REVISION_COLUMNS = defineColumns<BudgetRevision>([
  { id: 'no', header: 'Rev.', kind: 'number', value: (r) => r.revisionNo, width: 56 },
  { id: 'at', header: 'When (UTC)', kind: 'text', value: (r) => r.revisedAt, width: 150, className: 'num text-muted' },
  { id: 'user', header: 'By', kind: 'text', value: (r) => r.userName ?? '', width: 110 },
  { id: 'reason', header: 'Reason', kind: 'text', value: (r) => r.reason ?? '', minWidth: 140 },
  { id: 'before', header: 'Total before', kind: 'money', value: (r) => r.totalBefore, width: 124 },
  { id: 'after', header: 'Total after', kind: 'money', value: (r) => r.totalAfter, width: 124 },
  { id: 'lines', header: 'Lines', kind: 'text', value: (r) => `${r.linesBefore} → ${r.linesAfter}`, width: 72, className: 'text-muted' }
])

type Spread = BudgetPhasing | 'month'

/** One editable row in the budget line editor — the pre-save shape. */
export interface EditRow {
  key: number
  targetType: 'ledger' | 'group'
  ledgerId: number | null
  groupId: number | null
  costCentreId: number | null
  spread: Spread
  month: string | null
  amount: number | null
  monthly: (number | null)[]
}

let rowKeySeq = 0
const blankMonthly = (): (number | null)[] => Array<number | null>(12).fill(null)
const newRow = (): EditRow => ({ key: rowKeySeq++, targetType: 'ledger', ledgerId: null, groupId: null, costCentreId: null, spread: 'annual', month: null, amount: null, monthly: blankMonthly() })

export function rowsFromBudget(b: Budget): EditRow[] {
  return b.lines.map((l) => ({
    key: rowKeySeq++,
    targetType: l.ledgerId != null ? 'ledger' : 'group',
    ledgerId: l.ledgerId,
    groupId: l.groupId,
    costCentreId: l.costCentreId,
    spread: l.month ? 'month' : l.phasing,
    month: l.month,
    amount: l.amount,
    monthly: l.monthly ? [...l.monthly] : blankMonthly()
  }))
}

/** Editor rows → budget lines, with a message per bad row. Blank rows are skipped. */
export function linesFromRows(rows: EditRow[], months: string[]): { lines: BudgetLineInput[]; errors: string[] } {
  const lines: BudgetLineInput[] = []
  const errors: string[] = []
  rows.forEach((r, i) => {
    const targetId = r.targetType === 'ledger' ? r.ledgerId : r.groupId
    const manualTotal = r.monthly.reduce<number>((s, v) => s + (v ?? 0), 0)
    const amount = r.spread === 'manual' ? manualTotal : r.amount
    if (targetId == null && !amount) return
    if (targetId == null) return void errors.push(`Line ${i + 1}: pick a ${r.targetType}`)
    if (amount == null || amount <= 0) return void errors.push(`Line ${i + 1}: enter an amount above zero`)
    if (r.spread === 'month' && !r.month) return void errors.push(`Line ${i + 1}: pick the month`)
    lines.push({
      ledgerId: r.targetType === 'ledger' ? targetId : null,
      groupId: r.targetType === 'group' ? targetId : null,
      month: r.spread === 'month' ? (r.month ?? months[0]!) : null,
      amount,
      costCentreId: r.costCentreId,
      phasing: r.spread === 'month' ? 'annual' : r.spread,
      monthly: r.spread === 'manual' ? r.monthly.map((v) => v ?? 0) : null
    })
  })
  return { lines, errors }
}

export function BudgetsScreen(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const groups = useGroups()
  const { data: budgetList, isLoading: budgetsLoading } = useQuery({ queryKey: ['budgets'], queryFn: api.budget.list })
  const { data: costCentres = [] } = useQuery({ queryKey: ['costCentres'], queryFn: api.cc.list })
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [rows, setRows] = useState<EditRow[]>([])
  const [seasonal, setSeasonal] = useState<number[]>(Array(12).fill(1))
  const [editorDirty, setEditorDirty] = useState(false)
  useUnsavedGuard(editorDirty)
  const [lineErrors, setLineErrors] = useState<string[]>([])
  const [upToMonth, setUpToMonth] = useState(todayISO().slice(0, 7))
  const [view, setView] = useState<'summary' | 'months'>('summary')
  const [drill, setDrill] = useState<MonthlyVarianceRow | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [importErrors, setImportErrors] = useState<string[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  const budgets = budgetList ?? []
  const selected = budgets.find((b) => b.id === selectedId) ?? null

  useEffect(() => {
    if (!selectedId && budgets.length > 0) setSelectedId(budgets[0]!.id)
  }, [budgets, selectedId])

  // Reset the editor (and the default variance month) whenever the selected budget changes or reloads.
  useEffect(() => {
    if (!selected) {
      setRows([])
      return
    }
    setRows(selected.lines.length > 0 ? rowsFromBudget(selected) : [newRow()])
    setSeasonal(selected.seasonal ?? Array(12).fill(1))
    setEditorDirty(false)
    setLineErrors([])
    setImportErrors([])
    const months = fyMonthList(selected.fyStartYear)
    const currentMonth = todayISO().slice(0, 7)
    setUpToMonth(months.includes(currentMonth) ? currentMonth : months[months.length - 1]!)
  }, [selected?.id, JSON.stringify(selected?.lines)]) // eslint-disable-line react-hooks/exhaustive-deps

  const { data: report, isLoading: reportLoading } = useQuery({
    queryKey: ['budgetMonthly', selected?.id, upToMonth],
    queryFn: () => cfApi.budget.monthly(selected!.id, upToMonth),
    enabled: !!selected
  })

  const months = selected ? fyMonthList(selected.fyStartYear) : []
  const summaryCols = useMemo(() => summaryColumns(monthLabel(upToMonth)), [upToMonth])
  const monthCols = useMemo(() => monthColumns(months, upToMonth), [months.join(), upToMonth]) // eslint-disable-line react-hooks/exhaustive-deps
  const usesSeasonal = rows.some((r) => r.spread === 'seasonal')
  const hasCc = costCentres.length > 0

  const updateRow = (key: number, patch: Partial<EditRow>): void => {
    setEditorDirty(true)
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }
  const removeRow = (key: number): void => {
    setEditorDirty(true)
    setRows((prev) => prev.filter((r) => r.key !== key))
  }

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['budgets'] })
    await queryClient.invalidateQueries({ queryKey: ['budgetMonthly'] })
    await queryClient.invalidateQueries({ queryKey: ['budgetVariance'] })
    await queryClient.invalidateQueries({ queryKey: ['budgetRevisions'] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard', 'financeReminders'] })
  }

  const save = async (): Promise<void> => {
    if (!selected) return
    const { lines, errors } = linesFromRows(rows, months)
    setLineErrors(errors)
    if (errors.length > 0) return
    // A revision of a budget that already had lines asks why (optional — kept in the history).
    let reason: string | null = null
    if (selected.lines.length > 0) {
      reason = await promptDialog({ title: 'Revise budget', message: 'Why is it being revised? (optional — shown in the revision history)', placeholder: 'e.g. Q2 re-forecast', confirmLabel: 'Save' })
      if (reason === null) return
    }
    try {
      await api.budget.save({ name: selected.name, fyStartYear: selected.fyStartYear, lines, seasonal: usesSeasonal ? seasonal : selected.seasonal, reason: reason?.trim() || null }, selected.id)
      setEditorDirty(false)
      await refresh()
      toast.push('success', 'Budget saved')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const remove = async (b: Budget): Promise<void> => {
    const proceed = await confirmDialog({ title: 'Delete budget', message: `Delete budget “${b.name}”?`, confirmLabel: 'Delete', danger: true })
    if (!proceed) return
    try {
      await api.budget.remove(b.id)
      setSelectedId(null)
      await refresh()
      toast.push('success', 'Budget deleted')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const exportCsv = async (): Promise<void> => {
    if (!selected) return
    try {
      const r = await cfApi.budget.exportCsv(selected.id)
      toast.push('success', `Saved ${r.path.split(/[\\/]/).pop()} to the company’s exports folder`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const importCsv = async (file: File): Promise<void> => {
    if (!selected) return
    try {
      const r = await cfApi.budget.importCsv(selected.id, await file.text(), `CSV import: ${file.name}`.slice(0, 200))
      setImportErrors(r.errors)
      if (r.errors.length === 0) {
        await refresh()
        toast.push('success', `Imported ${r.lines} line${r.lines === 1 ? '' : 's'}`)
      }
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Page width="full">
      <PageHeader
        title="Budgets"
        subtitle={selected ? `${selected.name} · FY ${fyFromStartYear(selected.fyStartYear).label}` : undefined}
        actions={
          <Button variant="primary" data-testid="btn-budgets-new" onClick={() => setNewOpen(true)}>
            New budget
          </Button>
        }
        secondary={
          selected && (
            <>
              <Button variant="ghost" data-testid="btn-budgets-history" onClick={() => setHistoryOpen(true)}>History</Button>
              <Button variant="ghost" data-testid="btn-budgets-export" onClick={() => void exportCsv()}>Export CSV</Button>
              <Button variant="ghost" data-testid="btn-budgets-import" onClick={() => fileRef.current?.click()}>Import CSV</Button>
              <input
                ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" data-testid="input-budgets-import"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void importCsv(f)
                  e.target.value = ''
                }}
              />
            </>
          )
        }
        options={{
          content: selected ? (
            <>
              <OptionsTable area="budget-variance" label="Variance table" />
              <DrawerSection title="Reading the variance">
                <p className="text-hint text-muted">
                  Variance is actual − budget. For income targets more is favourable; for every other target less is. Annual lines
                  without a spread compare the whole year’s figure with the actual to date; spread lines compare month by month.
                  Actuals follow the P&amp;L (closing journals excluded); a cost-centre line counts only amounts allocated to that
                  centre and its sub-centres.
                </p>
              </DrawerSection>
            </>
          ) : (
            <DrawerSection title="Variance table">
              <p className="text-hint text-muted">Create or pick a budget to see its variance.</p>
            </DrawerSection>
          )
        }}
      />

      <Panel className="mb-section p-panel">
        {budgetsLoading ? (
          <SkeletonRows rows={2} />
        ) : budgets.length === 0 ? (
          <EmptyState title="No budgets yet" hint="Set targets by ledger, group or cost centre and track actuals against them" />
        ) : (
          <div className="flex items-center gap-3">
            <Select className="max-w-xs" aria-label="Budget" value={selectedId ?? ''} onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : null)} data-testid="select-budget">
              {budgets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} · FY {fyFromStartYear(b.fyStartYear).label}
                </option>
              ))}
            </Select>
            {selected && (
              <button type="button" className="text-small text-danger hover:underline" onClick={() => void remove(selected)}>
                Delete budget
              </button>
            )}
          </div>
        )}
      </Panel>

      {importErrors.length > 0 && (
        <Banner tone="danger" title="Nothing was imported — fix these lines" className="mb-section" testId="budgets-import-errors" onDismiss={() => setImportErrors([])}>
          {importErrors.slice(0, 8).map((e, i) => <p key={i}>{e}</p>)}
          {importErrors.length > 8 && <p>…and {importErrors.length - 8} more</p>}
        </Banner>
      )}

      {selected && (
        <>
          <Panel className="mb-section">
            <ScrollList maxH="50vh">
              <table className="ledger-table" data-testid="budget-lines">
                <thead>
                  <tr>
                    <th className="w-28">Target</th>
                    <th>Ledger / group</th>
                    {hasCc && <th className="w-40">Cost centre</th>}
                    <th className="w-48">Spread</th>
                    <th className="r w-36">Amount</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <LineRows
                      key={r.key}
                      row={r}
                      months={months}
                      groups={groups}
                      costCentres={hasCc ? costCentres : null}
                      update={(patch) => updateRow(r.key, patch)}
                      remove={() => removeRow(r.key)}
                    />
                  ))}
                </tbody>
              </table>
            </ScrollList>
            {usesSeasonal && <SeasonalEditor months={months} weights={seasonal} onChange={(w) => { setSeasonal(w); setEditorDirty(true) }} />}
            {lineErrors.length > 0 && (
              <div data-testid="budgets-line-errors" className="border-t border-line bg-danger-soft px-3 py-2 text-body-sm text-danger" role="alert">
                <p className="font-medium">Fix these lines before saving:</p>
                {lineErrors.map((e, i) => (
                  <p key={i}>{e}</p>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between border-t border-line p-3">
              <button
                data-testid="btn-budgets-add-line"
                className="text-body-sm text-blue hover:underline"
                onClick={() => {
                  setEditorDirty(true)
                  setRows((prev) => [...prev, newRow()])
                }}
              >
                + Add line
              </button>
              <Button data-testid="btn-budgets-save" variant="primary" onClick={() => void save()}>
                Save budget
              </Button>
            </div>
          </Panel>

          <SectionTitle
            right={
              <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
                <span className="shrink-0">
                  <Segmented label="Variance view" size="sm" options={[{ value: 'summary', label: 'Month & YTD' }, { value: 'months', label: 'By month' }]} value={view} onChange={setView} testId="seg-budget-view" />
                </span>
                <Select className="w-40 shrink-0" aria-label="Variance through month" value={upToMonth} onChange={(e) => setUpToMonth(e.target.value)} data-testid="select-budget-month">
                  {months.map((m) => (
                    <option key={m} value={m}>
                      {monthLabel(m)}
                    </option>
                  ))}
                </Select>
              </span>
            }
          >
            Variance · {monthLabel(upToMonth)} and year to date
          </SectionTitle>
          <Panel>
            <DataTable
              viewId={view === 'summary' ? 'budget-variance-v2' : 'budget-variance-months'}
              testId="budget-variance"
              ariaLabel="Budget variance"
              columns={view === 'summary' ? summaryCols : monthCols}
              rows={report?.rows ?? []}
              rowKey={(v) => v.lineId}
              rowAttrs={(v) => ({ 'data-line-id': v.lineId, 'data-ytd-favourable': v.ytd.favourable == null ? undefined : String(v.ytd.favourable) })}
              onRowActivate={(v) => setDrill(v)}
              loading={reportLoading}
              empty={{ title: 'No budget lines to compare yet', hint: 'Add a line above and save the budget' }}
              maxHeight="60vh"
              exportOptions={{
                title: `Budget variance — ${selected.name}`,
                periodLabel: `FY ${fyFromStartYear(selected.fyStartYear).label} · ${monthLabel(upToMonth)} and year to date`,
                filename: 'budget-variance'
              }}
            />
          </Panel>
        </>
      )}

      {drill && selected && <DrillDrawer budgetId={selected.id} row={drill} upToMonth={upToMonth} onClose={() => setDrill(null)} />}
      {historyOpen && selected && <HistoryDrawer budget={selected} onClose={() => setHistoryOpen(false)} />}
      {newOpen && (
        <NewBudgetModal
          onClose={() => setNewOpen(false)}
          onCreated={(b) => {
            setSelectedId(b.id)
            setNewOpen(false)
          }}
        />
      )}
    </Page>
  )
}

function LineRows({
  row: r, months, groups, costCentres, update, remove
}: {
  row: EditRow
  months: string[]
  groups: { id: number; name: string }[]
  costCentres: { id: number; name: string; active: boolean }[] | null
  update: (patch: Partial<EditRow>) => void
  remove: () => void
}): React.JSX.Element {
  const manualTotal = r.monthly.reduce<number>((s, v) => s + (v ?? 0), 0)
  const spreadValue = r.spread === 'month' ? `month:${r.month ?? ''}` : r.spread
  return (
    <>
      <tr data-testid="budget-line">
        <td>
          <Select aria-label="Target type" value={r.targetType} onChange={(e) => update({ targetType: e.target.value as 'ledger' | 'group', ledgerId: null, groupId: null })}>
            <option value="ledger">Ledger</option>
            <option value="group">Group</option>
          </Select>
        </td>
        <td>
          {r.targetType === 'ledger' ? (
            <LedgerPicker value={r.ledgerId} onPick={(id) => update({ ledgerId: id })} testId="picker-budget-ledger" />
          ) : (
            <Select aria-label="Group" value={r.groupId ?? ''} onChange={(e) => update({ groupId: e.target.value ? Number(e.target.value) : null })} data-testid="select-budget-group">
              <option value="">Choose a group…</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </Select>
          )}
        </td>
        {costCentres && (
          <td>
            <Select aria-label="Cost centre" value={r.costCentreId ?? ''} onChange={(e) => update({ costCentreId: e.target.value ? Number(e.target.value) : null })} data-testid="select-budget-cc">
              <option value="">All (whole ledger)</option>
              {costCentres.filter((c) => c.active || c.id === r.costCentreId).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </td>
        )}
        <td>
          <Select
            aria-label="Spread"
            value={spreadValue}
            data-testid="select-budget-spread"
            onChange={(e) => {
              const v = e.target.value
              if (v.startsWith('month:')) update({ spread: 'month', month: v.slice(6) || months[0]! })
              else if (v === 'manual') {
                // Seed the months from the current amount spread evenly, so switching loses nothing.
                const seed = r.amount ? phaseByWeights(r.amount, Array(12).fill(1)) : blankMonthly()
                update({ spread: 'manual', month: null, monthly: r.monthly.some((x) => x) ? r.monthly : seed })
              } else update({ spread: v as BudgetPhasing, month: null })
            }}
          >
            <optgroup label="Whole year">
              {(['annual', 'even', 'seasonal', 'manual'] as const).map((p) => (
                <option key={p} value={p}>{PHASING_LABELS[p]}</option>
              ))}
            </optgroup>
            <optgroup label="One month">
              {months.map((m) => (
                <option key={m} value={`month:${m}`}>{monthLabel(m)}</option>
              ))}
            </optgroup>
          </Select>
        </td>
        <td>
          {r.spread === 'manual' ? (
            <span className="num block px-2 text-right text-ink" data-testid="budget-line-manual-total">{formatPaise(manualTotal)}</span>
          ) : (
            <AmountInput paise={r.amount} onPaise={(paise) => update({ amount: paise })} ariaLabel="Amount" testId="input-budget-amount" />
          )}
        </td>
        <td className="r">
          <button type="button" aria-label="Remove line" className="text-small text-muted hover:text-danger" onClick={remove}>
            ✕
          </button>
        </td>
      </tr>
      {r.spread === 'manual' && (
        <tr className="dt-detail">
          <td colSpan={costCentres ? 6 : 5} className="bg-panel2">
            <div className="grid grid-cols-6 gap-2 py-1 xl:grid-cols-12" aria-label="Monthly amounts">
              {months.map((m, i) => (
                <label key={m} className="flex flex-col gap-0.5">
                  <span className="text-caption text-muted">{monthLabel(m).slice(0, 3)}</span>
                  <AmountInput
                    paise={r.monthly[i] ?? null}
                    ariaLabel={`${monthLabel(m)} amount`}
                    testId={`input-budget-month-${i}`}
                    onPaise={(p) => update({ monthly: r.monthly.map((x, j) => (j === i ? p : x)) })}
                  />
                </label>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function SeasonalEditor({ months, weights, onChange }: { months: string[]; weights: number[]; onChange: (w: number[]) => void }): React.JSX.Element {
  const total = weights.reduce((s, w) => s + w, 0)
  return (
    <div className="border-t border-line p-3" data-testid="budget-seasonal">
      <p className="mb-2 text-body-sm text-ink">
        Seasonal profile <span className="text-hint text-muted">— whole-number weights per month; a month with weight 2 gets twice an average month. Used by every “Seasonal profile” line.</span>
      </p>
      <div className="grid grid-cols-6 gap-2 xl:grid-cols-12">
        {months.map((m, i) => (
          <label key={m} className="flex flex-col gap-0.5">
            <span className="text-caption text-muted">{monthLabel(m).slice(0, 3)} · {total ? Math.round((weights[i]! * 100) / total) : 0}%</span>
            <TextInput
              value={String(weights[i] ?? 0)}
              inputMode="numeric"
              aria-label={`${monthLabel(m)} weight`}
              data-testid={`input-budget-weight-${i}`}
              onChange={(e) => onChange(weights.map((w, j) => (j === i ? Math.min(1000, Number(e.target.value.replace(/\D/g, '')) || 0) : w)))}
            />
          </label>
        ))}
      </div>
    </div>
  )
}

function DrillDrawer({ budgetId, row, upToMonth, onClose }: { budgetId: number; row: MonthlyVarianceRow; upToMonth: string; onClose: () => void }): React.JSX.Element {
  const [scope, setScope] = useState<'month' | 'ytd'>('ytd')
  const month = scope === 'month' ? upToMonth : null
  const { data = [], isLoading } = useQuery({
    queryKey: ['budgetDrill', budgetId, row.lineId, month, upToMonth],
    queryFn: () => cfApi.budget.drill(budgetId, row.lineId, month, upToMonth)
  })
  const f = scope === 'month' ? row.current : row.ytd
  return (
    <Drawer
      title={`${row.targetName}${row.costCentreName ? ` · ${row.costCentreName}` : ''}`}
      subtitle={`Budget ${f.budget == null ? '—' : formatPaise(f.budget, { symbol: true })} · actual ${formatPaise(f.actual, { symbol: true })}`}
      onClose={onClose}
      width={680}
      testId="budget-drill"
    >
      <div className="mb-2">
        <Segmented label="Period" size="sm" options={[{ value: 'month', label: monthLabel(upToMonth) }, { value: 'ytd', label: 'Year to date' }]} value={scope} onChange={setScope} testId="seg-budget-drill" />
      </div>
      <DataTable testId="budget-drill" ariaLabel="Vouchers behind the actual" columns={DRILL_COLUMNS} rows={data} loading={isLoading} maxHeight="70vh" empty={{ title: 'No vouchers in this period' }} />
    </Drawer>
  )
}

function HistoryDrawer({ budget, onClose }: { budget: Budget; onClose: () => void }): React.JSX.Element {
  const { data = [], isLoading } = useQuery({ queryKey: ['budgetRevisions', budget.id], queryFn: () => cfApi.budget.revisions(budget.id) })
  return (
    <Drawer title="Revision history" subtitle={`${budget.name} · FY ${fyFromStartYear(budget.fyStartYear).label}`} onClose={onClose} width={760} testId="budget-history">
      <DataTable testId="budget-revisions" ariaLabel="Budget revisions" columns={REVISION_COLUMNS} rows={data} loading={isLoading} maxHeight="70vh" empty={{ title: 'No revisions yet', hint: 'Every save of this budget after its first is recorded here, with the reason given' }} />
      <p className="mt-2 text-hint text-muted">The full before / after of each revision is also in the edit log ({toDisplayDate(todayISO())}).</p>
    </Drawer>
  )
}

function NewBudgetModal({ onClose, onCreated }: { onClose: () => void; onCreated: (b: Budget) => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const currentFy = fyOf(todayISO())
  const [name, setName] = useState('')
  const [fyStartYear, setFyStartYear] = useState(currentFy.startYear)

  const create = async (): Promise<void> => {
    if (!name.trim()) return
    try {
      const created = await api.budget.save({ name: name.trim(), fyStartYear, lines: [] })
      await queryClient.invalidateQueries({ queryKey: ['budgets'] })
      toast.push('success', 'Budget created')
      onCreated(created)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="New budget" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Operating Budget" data-testid="input-budget-name" />
        </Field>
        <Field label="Financial year">
          <Select data-testid="select-budgets-fy" value={fyStartYear} onChange={(e) => setFyStartYear(Number(e.target.value))}>
            {Array.from({ length: 7 }, (_, i) => currentFy.startYear + 1 - i).map((y) => (
              <option key={y} value={y}>
                FY {fyFromStartYear(y).label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="btn-budget-create" onClick={() => void create()}>
            Create budget
          </Button>
        </div>
      </div>
    </Modal>
  )
}
