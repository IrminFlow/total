import { Fragment, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, DateInput, EmptyState, Money, Panel, SectionTitle, Select, SkeletonRows, useKeyNav } from '../components/ui'
import { ReportConfigButton } from '../components/ReportConfigButton'
import { SavedViews } from '../components/SavedViews'
import { TabBar } from '../components/TabBar'
import { useReportConfig, type ReportColumn } from '../lib/reportConfig'
import { csvReport, printReport, xlsReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow, XlsExportSheet } from '../lib/client'
import { useStickyFlag, useStickyTab } from '../lib/useStickyTab'
import { useVirtualRows } from '../lib/useVirtualRows'
import { abnormalReason } from '@shared/abnormalBalance'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { groupTrialBalance, type TbGroupBy } from '@shared/tbGroups'
import type { TrialBalanceRow } from '@shared/reports'

const COLUMNS: ReportColumn[] = [
  { key: 'opening', label: 'Opening', defaultOn: false },
  { key: 'movement', label: 'Movement (Dr / Cr)', defaultOn: false },
  { key: 'debit', label: 'Debit', defaultOn: true },
  { key: 'credit', label: 'Credit', defaultOn: true }
]

/** Row height in px, matching `.ledger-table td` padding + line height. The virtualizer needs one
 *  number, so the rows are a fixed height by design rather than by accident. */
const ROW_H = 29

type Grouping = 'none' | TbGroupBy
const TABS = ['balances', 'changes'] as const

export function TrialBalanceScreen(): React.JSX.Element {
  const [tab, setTab] = useStickyTab('trial-balance', TABS, 'balances')
  return (
    <div className="flex h-full min-h-0 w-full flex-col max-w-[1440px]">
      <SectionTitle
        right={
          <TabBar
            screen="trial-balance"
            tabs={[
              { id: 'balances', label: 'Balances' },
              { id: 'changes', label: 'What changed' }
            ]}
            active={tab}
            onSelect={setTab}
          />
        }
      >
        Trial balance
      </SectionTitle>
      {tab === 'balances' ? <BalancesTab /> : <ChangesTab />}
    </div>
  )
}

function BalancesTab(): React.JSX.Element {
  const { to } = useSession()
  const nav = useNav()
  const toast = useToasts()
  // Hidden by default: a chart of accounts collects ledgers that were used once, and a trial
  // balance three screens long, mostly zeroes, hides the numbers that matter. But "never" is the
  // wrong answer too — a ledger you expected to see and cannot is indistinguishable from one that
  // does not exist — so the report itself takes the flag. A hidden zero cannot change a total,
  // which is what makes this safe and would not make hiding anything else safe.
  const [hideZeros, setHideZeros] = useStickyFlag('tb-hide-zeros', true)
  const [grouping, setGrouping] = useState<Grouping>(() => {
    try {
      const stored = localStorage.getItem('total-tb-grouping')
      return stored === 'group' || stored === 'topGroup' ? stored : 'none'
    } catch {
      return 'none'
    }
  })
  const setGroupingSticky = (g: Grouping): void => {
    setGrouping(g)
    try {
      localStorage.setItem('total-tb-grouping', g)
    } catch {
      // A locked-down localStorage costs the preference, not the click.
    }
  }
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const { data, isLoading } = useQuery({
    queryKey: ['trialBalance', to, hideZeros],
    queryFn: () => api.reports.trialBalance(to, !hideZeros)
  })
  const rows = data?.rows ?? []
  const { active, setActive } = useKeyNav(rows.length, (i) => {
    const r = rows[i]
    if (r && r.ledgerId > 0) nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })
  })
  const { visible, toggle } = useReportConfig('trial-balance', COLUMNS)

  const matched = data && data.totalDebit === data.totalCredit
  const sections = grouping === 'none' ? [] : groupTrialBalance(rows, grouping)

  const exportColumns: PdfColumn[] = [
    { label: 'Ledger', align: 'l' },
    { label: 'Group', align: 'l' },
    ...(visible.opening ? [{ label: 'Opening', align: 'r' as const }] : []),
    ...(visible.movement
      ? [{ label: 'Movement Dr', align: 'r' as const }, { label: 'Movement Cr', align: 'r' as const }]
      : []),
    ...(visible.debit ? [{ label: 'Debit', align: 'r' as const }] : []),
    ...(visible.credit ? [{ label: 'Credit', align: 'r' as const }] : [])
  ]
  const signedOpening = (p: number): string =>
    p === 0 ? '–' : `${formatPaise(Math.abs(p))} ${p > 0 ? 'Dr' : 'Cr'}`
  // Exports carry every row of the period, and every subtotal on screen — never the collapsed
  // view. A collapsed section in the UI is a thing the reader chose to fold; a missing section in
  // an exported file is a thing nobody knows is missing.
  const exportRows: PdfRow[] = [
    ...(grouping === 'none'
      ? rows.map((r) => ({ cells: rowCells(r, visible, signedOpening) }))
      : sections.flatMap((s) => [
          { cells: [s.name, '', ...blankMoney(visible)], bold: true },
          ...s.rows.map((r) => ({ cells: rowCells(r, visible, signedOpening), indent: 1 })),
          {
            cells: [
              `${s.name} total`,
              '',
              ...(visible.opening ? [signedOpening(s.totals.opening)] : []),
              ...(visible.movement
                ? [
                    formatPaise(s.totals.movementDebit, { zeroDash: true }),
                    formatPaise(s.totals.movementCredit, { zeroDash: true })
                  ]
                : []),
              ...(visible.debit ? [formatPaise(s.totals.debit, { zeroDash: true })] : []),
              ...(visible.credit ? [formatPaise(s.totals.credit, { zeroDash: true })] : [])
            ],
            bold: true
          }
        ])),
    {
      cells: [
        'Total',
        '',
        ...(visible.opening
          ? [signedOpening((data?.openingDebitTotal ?? 0) - (data?.openingCreditTotal ?? 0))]
          : []),
        ...(visible.movement
          ? [
              formatPaise(data?.movementDebitTotal ?? 0, { zeroDash: true }),
              formatPaise(data?.movementCreditTotal ?? 0, { zeroDash: true })
            ]
          : []),
        ...(visible.debit ? [formatPaise(data?.totalDebit ?? 0, { zeroDash: true })] : []),
        ...(visible.credit ? [formatPaise(data?.totalCredit ?? 0, { zeroDash: true })] : [])
      ],
      bold: true,
      rule: true
    }
  ]

  const xlsSheet = (): XlsExportSheet => ({
    name: 'Trial balance',
    columns: [
      { label: 'Ledger', kind: 'text' },
      { label: 'Group', kind: 'text' },
      ...(visible.opening ? [{ label: 'Opening', kind: 'money' as const }] : []),
      ...(visible.movement
        ? [{ label: 'Movement Dr', kind: 'money' as const }, { label: 'Movement Cr', kind: 'money' as const }]
        : []),
      ...(visible.debit ? [{ label: 'Debit', kind: 'money' as const }] : []),
      ...(visible.credit ? [{ label: 'Credit', kind: 'money' as const }] : [])
    ],
    rows: [
      ...rows.map((r) => ({
        cells: [
          r.ledgerName,
          r.groupName,
          ...(visible.opening ? [r.opening] : []),
          ...(visible.movement ? [r.movementDebit, r.movementCredit] : []),
          ...(visible.debit ? [r.debit] : []),
          ...(visible.credit ? [r.credit] : [])
        ]
      })),
      {
        cells: [
          'Total',
          '',
          ...(visible.opening ? [(data?.openingDebitTotal ?? 0) - (data?.openingCreditTotal ?? 0)] : []),
          ...(visible.movement ? [data?.movementDebitTotal ?? 0, data?.movementCreditTotal ?? 0] : []),
          ...(visible.debit ? [data?.totalDebit ?? 0] : []),
          ...(visible.credit ? [data?.totalCredit ?? 0] : [])
        ],
        bold: true
      }
    ]
  })

  // Virtualization only applies to the ungrouped list. Windowing across sections whose headers
  // and subtotals are different row heights would need a measured layout for a case that does
  // not arise: a grouped view is read section by section, collapsed, not scrolled by the
  // thousand.
  const { scrollRef, window: win, virtualized } = useVirtualRows(grouping === 'none' ? rows.length : 0, ROW_H)

  return (
    <>
      <div className="mb-2 flex items-center justify-end gap-2">
        <span className="num text-small text-muted">as on {toDisplayDate(to)}</span>
        <Select
          aria-label="Group rows"
          data-testid="select-tb-grouping"
          value={grouping}
          onChange={(e) => setGroupingSticky(e.currentTarget.value as Grouping)}
          className="w-40"
        >
          <option value="none">No grouping</option>
          <option value="group">By group</option>
          <option value="topGroup">By primary group</option>
        </Select>
        <Button
          variant="ghost"
          data-testid="btn-tb-hide-zeros"
          onClick={() => setHideZeros(!hideZeros)}
          title={hideZeros ? 'Show ledgers with no balance and no movement' : 'Hide them again'}
        >
          {hideZeros ? 'Show empty ledgers' : 'Hide empty ledgers'}
        </Button>
        <ReportConfigButton columns={COLUMNS} visible={visible} toggle={toggle} />
        <SavedViews<{ hideZeros: boolean; grouping: Grouping }>
          screen="trial-balance"
          state={{ hideZeros, grouping }}
          onRestore={(v) => {
            setHideZeros(v.hideZeros)
            setGroupingSticky(v.grouping)
          }}
        />
        <Button
          variant="ghost"
          onClick={() =>
            void printReport(
              { title: 'Trial balance', periodLabel: `as on ${toDisplayDate(to)}`, columns: exportColumns, rows: exportRows },
              toast
            )
          }
        >
          PDF
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            void csvReport(exportColumns.map((c) => c.label), exportRows.map((r) => r.cells), 'trial-balance', toast)
          }
        >
          CSV
        </Button>
        <Button variant="ghost" data-testid="btn-tb-xls" onClick={() => void xlsReport('trial-balance', [xlsSheet()], toast)}>
          XLS
        </Button>
      </div>
      <Panel className="card-fit flex flex-col">
        {isLoading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <EmptyState title="No balances yet" hint="Enter a voucher or set opening balances" />
        ) : (
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th scope="col">Ledger</th>
                  <th scope="col">Group</th>
                  {visible.opening && <th scope="col" className="r w-36">Opening</th>}
                  {visible.movement && <th scope="col" className="r w-36">Movement Dr</th>}
                  {visible.movement && <th scope="col" className="r w-36">Movement Cr</th>}
                  {visible.debit && <th scope="col" className="r w-40">Debit</th>}
                  {visible.credit && <th scope="col" className="r w-40">Credit</th>}
                </tr>
              </thead>
              <tbody data-testid="rows-trial-balance">
                {grouping === 'none' ? (
                  <>
                    {/* Spacer rows, not transforms: a transformed tbody breaks table layout, and
                        the point of virtualizing is to keep this a real table. */}
                    {win.padTop > 0 && (
                      <tr aria-hidden style={{ height: win.padTop }}>
                        <td colSpan={7} />
                      </tr>
                    )}
                    {rows.slice(win.start, win.end).map((r, i) => (
                      <LedgerRow
                        key={r.ledgerId}
                        row={r}
                        visible={visible}
                        activeRow={win.start + i === active}
                        onHover={() => setActive(win.start + i)}
                        onOpen={() => r.ledgerId > 0 && nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })}
                      />
                    ))}
                    {win.padBottom > 0 && (
                      <tr aria-hidden style={{ height: win.padBottom }}>
                        <td colSpan={7} />
                      </tr>
                    )}
                  </>
                ) : (
                  sections.map((s) => {
                    const isCollapsed = collapsed.has(s.key)
                    return (
                      <Fragment key={s.key}>
                        <tr
                          className="cursor-pointer bg-panel2/60 font-medium"
                          data-testid={`tb-group-${s.key}`}
                          onClick={() =>
                            setCollapsed((prev) => {
                              const next = new Set(prev)
                              if (next.has(s.key)) next.delete(s.key)
                              else next.add(s.key)
                              return next
                            })
                          }
                        >
                          <td colSpan={2}>
                            <span className="mr-1.5 inline-block w-3 text-muted">{isCollapsed ? '▸' : '▾'}</span>
                            {s.name}
                            <span className="ml-2 text-hint text-muted">
                              {s.rows.length} ledger{s.rows.length === 1 ? '' : 's'}
                            </span>
                          </td>
                          {visible.opening && (
                            <td className="r">
                              <Money paise={s.totals.opening} signed />
                            </td>
                          )}
                          {visible.movement && (
                            <td className="r">
                              <Money paise={s.totals.movementDebit} />
                            </td>
                          )}
                          {visible.movement && (
                            <td className="r">
                              <Money paise={s.totals.movementCredit} />
                            </td>
                          )}
                          {visible.debit && (
                            <td className="r">
                              <Money paise={s.totals.debit} />
                            </td>
                          )}
                          {visible.credit && (
                            <td className="r">
                              <Money paise={s.totals.credit} />
                            </td>
                          )}
                        </tr>
                        {!isCollapsed &&
                          s.rows.map((r) => (
                            <LedgerRow
                              key={r.ledgerId}
                              row={r}
                              visible={visible}
                              indent
                              onOpen={() => r.ledgerId > 0 && nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })}
                            />
                          ))}
                      </Fragment>
                    )
                  })
                )}
                <tr className="total-row">
                  <td colSpan={2}>Total {matched ? '' : '— debits and credits differ; check opening balances'}</td>
                  {visible.opening && (
                    <td className="r">
                      <Money paise={(data?.openingDebitTotal ?? 0) - (data?.openingCreditTotal ?? 0)} signed />
                    </td>
                  )}
                  {visible.movement && (
                    <td className="r">
                      <Money paise={data?.movementDebitTotal ?? 0} />
                    </td>
                  )}
                  {visible.movement && (
                    <td className="r">
                      <Money paise={data?.movementCreditTotal ?? 0} />
                    </td>
                  )}
                  {visible.debit && (
                    <td className="r">
                      <Money paise={data?.totalDebit ?? 0} />
                    </td>
                  )}
                  {visible.credit && (
                    <td className="r">
                      <Money paise={data?.totalCredit ?? 0} />
                    </td>
                  )}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {virtualized && (
        <p className="mt-1 text-hint text-muted" data-testid="tb-virtualized-note">
          Showing {rows.length.toLocaleString('en-IN')} ledgers — rows are drawn as you scroll. Exports carry all of them.
        </p>
      )}
    </>
  )
}

function blankMoney(visible: Record<string, boolean>): string[] {
  const n = (visible.opening ? 1 : 0) + (visible.movement ? 2 : 0) + (visible.debit ? 1 : 0) + (visible.credit ? 1 : 0)
  return Array.from({ length: n }, () => '')
}

function rowCells(
  r: TrialBalanceRow,
  visible: Record<string, boolean>,
  signedOpening: (p: number) => string
): string[] {
  return [
    r.ledgerName,
    r.groupName,
    ...(visible.opening ? [signedOpening(r.opening)] : []),
    ...(visible.movement
      ? [formatPaise(r.movementDebit, { zeroDash: true }), formatPaise(r.movementCredit, { zeroDash: true })]
      : []),
    ...(visible.debit ? [formatPaise(r.debit, { zeroDash: true })] : []),
    ...(visible.credit ? [formatPaise(r.credit, { zeroDash: true })] : [])
  ]
}

function LedgerRow({
  row: r,
  visible,
  activeRow = false,
  indent = false,
  onHover,
  onOpen
}: {
  row: TrialBalanceRow
  visible: Record<string, boolean>
  activeRow?: boolean
  indent?: boolean
  onHover?: () => void
  onOpen: () => void
}): React.JSX.Element {
  return (
    <tr
      data-active={activeRow || undefined}
      className="kbar-row cursor-pointer"
      style={{ height: ROW_H }}
      onMouseEnter={onHover}
      onClick={onOpen}
    >
      {/* Inline padding, not a `pl-6` utility: `.ledger-table td` sets padding by element
          selector and wins on specificity, so the utility silently does nothing. */}
      <td style={indent ? { paddingLeft: 28 } : undefined}>
        {r.ledgerName}
        {/* An asset in credit or a liability in debit is usually a mistake, and usually one
            nobody looks for — the number is perfectly normal on the next row. Flagged, not
            errored: a genuine overdraft looks exactly like this. */}
        {abnormalReason(r.nature, r.debit - r.credit) && (
          <span
            className="ml-2 rounded-md bg-cr/10 px-1.5 py-0.5 text-label font-medium text-cr"
            data-testid="tb-abnormal"
            title={abnormalReason(r.nature, r.debit - r.credit) ?? undefined}
          >
            {r.nature === 'asset' ? 'Cr' : 'Dr'}?
          </span>
        )}
      </td>
      <td className="text-muted">{r.groupName}</td>
      {visible.opening && (
        <td className="r">
          <Money paise={r.opening} signed />
        </td>
      )}
      {visible.movement && (
        <td className="r">
          <Money paise={r.movementDebit} />
        </td>
      )}
      {visible.movement && (
        <td className="r">
          <Money paise={r.movementCredit} />
        </td>
      )}
      {visible.debit && (
        <td className="r">
          <Money paise={r.debit} />
        </td>
      )}
      {visible.credit && (
        <td className="r">
          <Money paise={r.credit} />
        </td>
      )}
    </tr>
  )
}

/**
 * What changed between two dates.
 *
 * Every other report answers "what is the balance". This one answers the question people actually
 * ask when something looks wrong — "what moved since I last looked" — and it ranks by the size of
 * the move, because listing ledgers by name is exactly what hides a change.
 *
 * Both dates are editable here rather than taken from the header period: the comparison people
 * want is usually last-close against today, which is not a period at all.
 */
function ChangesTab(): React.JSX.Element {
  const { from: sessionFrom, to: sessionTo } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const [from, setFrom] = useState(sessionFrom)
  const [to, setTo] = useState(sessionTo)
  useEffect(() => {
    setFrom(sessionFrom)
    setTo(sessionTo)
  }, [sessionFrom, sessionTo])

  const { data, isLoading } = useQuery({
    queryKey: ['whatChanged', from, to],
    queryFn: () => api.reports.whatChanged(from, to)
  })
  const rows = data?.rows ?? []

  const columns: PdfColumn[] = [
    { label: 'Ledger', align: 'l' },
    { label: 'Group', align: 'l' },
    { label: `As on ${toDisplayDate(from)}`, align: 'r' },
    { label: `As on ${toDisplayDate(to)}`, align: 'r' },
    { label: 'Change', align: 'r' },
    { label: '%', align: 'r' },
    { label: 'Entries', align: 'r' }
  ]
  const exportRows: PdfRow[] = rows.map((r) => ({
    cells: [
      r.ledgerName,
      r.groupName,
      formatPaise(r.opening, { zeroDash: true }),
      formatPaise(r.closing, { zeroDash: true }),
      formatPaise(r.change, { zeroDash: true }),
      r.changePct === null ? '–' : `${r.changePct}%`,
      String(r.vouchers)
    ]
  }))
  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`

  return (
    <>
      <div className="mb-2 flex items-center justify-end gap-2">
        <span className="text-small text-muted">between</span>
        <DateInput value={from} context={from} onChange={setFrom} className="w-28" testId="input-changed-from" />
        <span className="text-small text-muted">and</span>
        <DateInput value={to} context={to} onChange={setTo} className="w-28" testId="input-changed-to" />
        <Button
          variant="ghost"
          onClick={() => void printReport({ title: 'What changed', periodLabel, columns, rows: exportRows }, toast)}
        >
          PDF
        </Button>
        <Button
          variant="ghost"
          onClick={() => void csvReport(columns.map((c) => c.label), exportRows.map((r) => r.cells), 'what-changed', toast)}
        >
          CSV
        </Button>
        <Button
          variant="ghost"
          data-testid="btn-changed-xls"
          onClick={() =>
            void xlsReport(
              'what-changed',
              [
                {
                  name: 'What changed',
                  columns: [
                    { label: 'Ledger', kind: 'text' },
                    { label: 'Group', kind: 'text' },
                    { label: `As on ${from}`, kind: 'money' },
                    { label: `As on ${to}`, kind: 'money' },
                    { label: 'Change', kind: 'money' },
                    { label: '%', kind: 'number' },
                    { label: 'Entries', kind: 'number' }
                  ],
                  rows: rows.map((r) => ({
                    cells: [r.ledgerName, r.groupName, r.opening, r.closing, r.change, r.changePct, r.vouchers]
                  }))
                }
              ],
              toast
            )
          }
        >
          XLS
        </Button>
      </div>
      <Panel className="card-fit overflow-y-auto">
        {isLoading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing moved"
            hint={
              from >= to
                ? 'The second date has to be after the first — a range that ends where it starts contains no entries.'
                : 'No ledger changed between these two dates.'
            }
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Ledger</th>
                <th scope="col">Group</th>
                <th scope="col" className="r w-36">As on {toDisplayDate(from)}</th>
                <th scope="col" className="r w-36">As on {toDisplayDate(to)}</th>
                <th scope="col" className="r w-36">Change</th>
                <th scope="col" className="r w-20">%</th>
                <th scope="col" className="r w-20">Entries</th>
              </tr>
            </thead>
            <tbody data-testid="rows-what-changed">
              {rows.map((r) => (
                <tr
                  key={r.ledgerId}
                  className="kbar-row cursor-pointer"
                  onClick={() => nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })}
                >
                  <td>{r.ledgerName}</td>
                  <td className="text-muted">{r.groupName}</td>
                  <td className="r">
                    <Money paise={r.opening} signed />
                  </td>
                  <td className="r">
                    <Money paise={r.closing} signed />
                  </td>
                  <td className="r font-medium">
                    <Money paise={r.change} signed />
                  </td>
                  {/* An em dash, not 0%: a ledger that started at nothing has not grown by any
                      percentage, it has appeared. */}
                  <td className="r num text-muted">{r.changePct === null ? '–' : `${r.changePct}%`}</td>
                  <td className="r num text-muted">{r.vouchers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  )
}
