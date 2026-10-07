// The TDS screen (WP 3.2) — and, kind 'tcs', the TCS screen (WP 3.3): a ledger summary card (the tagged payable ledgers, like GST's tax
// ledgers) over five tabs — Eligible (vouchers that should carry TDS, Move to TDS), Deducted
// (every entry, edit / delete), Challans, Returns (26Q / Form 140 data, Form 16A data) and
// Sections (rates, deductees, certificates). Everything is computed from voucher lines and
// tds_entries at query time.
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fyOf, fyFromStartYear, todayISO } from '@shared/dates'
import { tdsQuarterOf } from '@shared/tds'
import type { TdsLedgerSummaryRow } from '../lib/client'
import { useSession } from '../state/stores'
import { DrawerSection, Money, Page, PageHeader, Panel, Select, StatGrid, StatTile, TabBar } from '../components/ui'
import { OptionsTable } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { LedgerLink } from '../components/links'
import { openLedgerStatement } from '../lib/drill'
import { KIND_WORDS, periodOf, withholdingApi, type QuarterChoice, type WithholdingKind } from './tds/common'
import { EligibleTab } from './tds/EligibleTab'
import { DeductedTab } from './tds/DeductedTab'
import { ChallansTab } from './tds/ChallansTab'
import { ReturnsTab } from './tds/ReturnsTab'
import { SectionsTab } from './tds/SectionsTab'

type TabId = 'eligible' | 'deducted' | 'challans' | 'returns' | 'sections'

/** The TDS ledger summary: one row per section with a tagged payable ledger (testId kept as
 *  `tds-summary` — e2e 03 reads it). */
export function summaryColumns(kind: WithholdingKind) {
  const w = KIND_WORDS[kind]
  return defineColumns<TdsLedgerSummaryRow>([
  { id: 'section', header: 'Section', kind: 'text', value: (r) => r.sectionCode, className: 'num', width: kind === 'tcs' ? 160 : 96, hideable: false, groupable: false },
  {
    id: 'ledger', header: 'Payable ledger', kind: 'text', value: (r) => r.ledgerName, minWidth: 170,
    cell: (r) => (r.ledgerId != null ? <LedgerLink ledgerId={r.ledgerId} name={r.ledgerName} /> : <span className="text-muted">Created on the first {w.noun}</span>)
  },
  { id: 'opening', header: 'Payable at start', kind: 'money', value: (r) => r.openingPaise, aggregate: 'sum', width: 150 },
  { id: 'deducted', header: w.done, kind: 'money', value: (r) => r.deductedPaise, aggregate: 'sum', width: 140 },
  { id: 'deposited', header: 'Deposited', kind: 'money', value: (r) => r.depositedPaise, aggregate: 'sum', width: 140 },
  { id: 'outstanding', header: 'Outstanding', kind: 'money', value: (r) => r.outstandingPaise, aggregate: 'sum', width: 140 },
  { id: 'deductees', header: `${w.party}s`, kind: 'number', value: (r) => r.deductees, width: 104 },
  { id: 'entries', header: 'Per entries', kind: 'money', value: (r) => r.entriesTdsPaise, aggregate: 'sum', width: 140, defaultHidden: true }
  ])
}

export const TDS_SUMMARY_COLUMNS = summaryColumns('tds')

export function TdsScreen(): React.JSX.Element {
  return <WithholdingScreen kind="tds" />
}

/** The TDS screen, or (kind 'tcs', WP 3.3) the TCS screen — one shell, one set of tabs. */
export function WithholdingScreen({ kind }: { kind: WithholdingKind }): React.JSX.Element {
  const w = KIND_WORDS[kind]
  const k = kind
  const wapi = withholdingApi(kind)
  const columns = useMemo(() => summaryColumns(kind), [kind])
  const { info } = useSession()
  const today = todayISO()
  const currentFy = fyOf(today)
  const [fyStartYear, setFyStartYear] = useState(currentFy.startYear)
  const [quarter, setQuarter] = useState<QuarterChoice>(tdsQuarterOf(today).q)
  const [tab, setTab] = useState<TabId>('eligible')
  const period = useMemo(() => periodOf(fyStartYear, quarter), [fyStartYear, quarter])

  const years: number[] = []
  for (let y = currentFy.startYear; y >= (info?.booksFrom ?? currentFy.startYear); y--) years.push(y)

  const { data: summary, isLoading } = useQuery({
    queryKey: [k, 'ledgerSummary', fyStartYear, quarter],
    queryFn: () => wapi.ledgerSummary(fyStartYear, quarter)
  })
  const { data: eligible } = useQuery({
    queryKey: [k, 'eligible', period.from, period.to, false],
    queryFn: () => wapi.eligible(period.from, period.to, false)
  })
  const rows = summary ?? []
  const total = (k: keyof Pick<TdsLedgerSummaryRow, 'openingPaise' | 'deductedPaise' | 'depositedPaise' | 'outstandingPaise'>): number =>
    rows.reduce((s, r) => s + r[k], 0)
  const eligibleCount = (eligible ?? []).filter((r) => !r.exemptReason).length

  return (
    <Page width="wide">
      <PageHeader
        title={w.name}
        period={period.label}
        tabs={
          <TabBar
            screen={k}
            label={`${w.name} views`}
            tabs={[
              { id: 'eligible', label: 'Eligible', count: eligibleCount || undefined },
              { id: 'deducted', label: w.done },
              { id: 'challans', label: 'Challans' },
              { id: 'returns', label: 'Returns' },
              { id: 'sections', label: 'Sections' }
            ]}
            active={tab}
            onSelect={(id) => setTab(id as TabId)}
          />
        }
        controls={
          <div className="flex items-center gap-2">
            <Select value={fyStartYear} onChange={(e) => setFyStartYear(Number(e.target.value))} className="w-36" aria-label="Financial year" data-testid={`input-${k}-fy`}>
              {years.map((y) => (
                <option key={y} value={y}>
                  FY {fyFromStartYear(y).label}
                </option>
              ))}
            </Select>
            <Select value={quarter} onChange={(e) => setQuarter(Number(e.target.value) as QuarterChoice)} className="w-32" aria-label="Quarter" data-testid={`input-${k}-quarter`}>
              {[1, 2, 3, 4].map((q) => (
                <option key={q} value={q}>
                  Q{q}
                </option>
              ))}
              <option value={0}>Full year</option>
            </Select>
          </div>
        }
        options={{
          content: kind === 'tcs' ? (
            <>
              <OptionsTable area="tcs-ledger-summary" label="TCS ledgers table" />
              <DrawerSection title="How this screen works">
                <p className="text-hint text-muted">
                  Eligible lists every sale that should carry TCS and doesn&apos;t — to a buyer flagged with a TCS section, of goods flagged with one
                  (scrap, timber, minerals, a motor vehicle above ₹10 lakh …) or through a sales ledger with a default section. Move to TCS alters
                  the sale through the normal save: the buyer&apos;s debit grows by the TCS and the section&apos;s TCS payable ledger is credited.
                </p>
              </DrawerSection>
              <DrawerSection title="About the 27EQ CSV">
                <p className="text-hint text-muted">
                  The 27EQ CSV (Form 143 from FY 2026-27) lists collectee, PAN, collectee code, section and collection codes, amounts, remarks and
                  challans for manual entry into the return preparation utility — it is not a ready-to-file FVU.
                </p>
              </DrawerSection>
            </>
          ) : (
            <>
              <OptionsTable area="tds-ledger-summary" label="TDS ledgers table" />
              <DrawerSection title="How this screen works">
                <p className="text-hint text-muted">
                  Eligible lists every purchase, journal or payment above its threshold that carries no TDS — thresholds count every bill and
                  advance to the party this year. Move to TDS alters the voucher through the normal save (lock date, audit, validation):
                  on a bill the supplier&apos;s credit gives up the deduction, on a payment the bank line does.
                </p>
              </DrawerSection>
              <DrawerSection title="About the 26Q CSV">
                <p className="text-hint text-muted">
                  The 26Q CSV lists deductee, PAN, section, voucher, amounts and challans for manual import into NSDL&apos;s Return Preparation
                  Utility — it is not a ready-to-file FVU.
                </p>
              </DrawerSection>
            </>
          )
        }}
      />

      <Panel className="mb-4">
        <div className="p-panel">
          <StatGrid>
            <StatTile label="Payable at start" value={<Money paise={total('openingPaise')} />} testId={`${k}-stat-opening`} />
            <StatTile label={`${w.done} · ${period.label}`} value={<Money paise={total('deductedPaise')} />} tone="cr" testId={`${k}-stat-deducted`} />
            <StatTile label="Deposited" value={<Money paise={total('depositedPaise')} />} tone="dr" testId={`${k}-stat-deposited`} />
            <StatTile
              label="Outstanding"
              value={<Money paise={total('outstandingPaise')} />}
              tone="amber"
              hint={
                total('outstandingPaise') > 0
                  ? kind === 'tcs'
                    ? `Due by the 7th of the next month (March: ${fyStartYear >= 2026 ? '30 April' : '7 April'})`
                    : 'Due by the 7th of the next month (30 April for March)'
                  : undefined
              }
              testId={`${k}-stat-outstanding`}
            />
          </StatGrid>
        </div>
        {!isLoading && rows.length === 0 ? (
          <p className="border-t border-line px-3 py-3 text-body-sm text-muted" data-testid={`${k}-summary-empty`}>
            No {w.name} payable in {period.label} — the section&apos;s payable ledger is created with its first {w.noun}.
          </p>
        ) : (
          <DataTable
            viewId={`${k}-ledger-summary`}
            testId={`${k}-summary`}
            ariaLabel={`${w.name} payable ledgers — ${period.label}`}
            columns={columns}
            rows={rows}
            loading={isLoading}
            rowKey={(r) => r.sectionId}
            rowAttrs={(r) => ({ 'data-row-id': r.sectionId })}
            isRowActivatable={(r) => r.ledgerId != null}
            onRowActivate={(r) => r.ledgerId != null && openLedgerStatement(r.ledgerId)}
            maxHeight="none"
            toolbarFeatures={{ groupBy: false, views: false }}
            empty={{ title: `No ${w.name} in ${period.label}`, hint: `Payable ledgers appear here once a ${w.noun} is saved` }}
            exportOptions={{ title: `${w.name} payable ledgers`, periodLabel: period.label, filename: `${k}-ledgers-${period.from}` }}
          />
        )}
      </Panel>

      {tab === 'eligible' && <EligibleTab period={period} kind={kind} />}
      {tab === 'deducted' && <DeductedTab period={period} kind={kind} />}
      {tab === 'challans' && <ChallansTab period={period} kind={kind} />}
      {tab === 'returns' && <ReturnsTab key={`${fyStartYear}-${quarter}`} fyStartYear={fyStartYear} initialQuarter={quarter} kind={kind} />}
      {tab === 'sections' && <SectionsTab kind={kind} />}
    </Page>
  )
}
