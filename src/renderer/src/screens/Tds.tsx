// The TDS screen (WP 3.2): a TDS ledger summary card (the tagged payable ledgers, like GST's tax
// ledgers) over five tabs — Eligible (vouchers that should carry TDS, Move to TDS), Deducted
// (every entry, edit / delete), Challans, Returns (26Q / Form 140 data, Form 16A data) and
// Sections (rates, deductees, certificates). Everything is computed from voucher lines and
// tds_entries at query time.
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fyOf, fyFromStartYear, todayISO } from '@shared/dates'
import { tdsQuarterOf } from '@shared/tds'
import { api, type TdsLedgerSummaryRow } from '../lib/client'
import { useSession } from '../state/stores'
import { DrawerSection, Money, Page, PageHeader, Panel, Select, StatGrid, StatTile, TabBar } from '../components/ui'
import { OptionsTable } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { LedgerLink } from '../components/links'
import { openLedgerStatement } from '../lib/drill'
import { periodOf, type QuarterChoice } from './tds/common'
import { EligibleTab } from './tds/EligibleTab'
import { DeductedTab } from './tds/DeductedTab'
import { ChallansTab } from './tds/ChallansTab'
import { ReturnsTab } from './tds/ReturnsTab'
import { SectionsTab } from './tds/SectionsTab'

type TabId = 'eligible' | 'deducted' | 'challans' | 'returns' | 'sections'

/** The TDS ledger summary: one row per section with a tagged payable ledger (testId kept as
 *  `tds-summary` — e2e 03 reads it). */
export const TDS_SUMMARY_COLUMNS = defineColumns<TdsLedgerSummaryRow>([
  { id: 'section', header: 'Section', kind: 'text', value: (r) => r.sectionCode, className: 'num', width: 96, hideable: false, groupable: false },
  {
    id: 'ledger', header: 'Payable ledger', kind: 'text', value: (r) => r.ledgerName, minWidth: 170,
    cell: (r) => (r.ledgerId != null ? <LedgerLink ledgerId={r.ledgerId} name={r.ledgerName} /> : <span className="text-muted">Created on the first deduction</span>)
  },
  { id: 'opening', header: 'Payable at start', kind: 'money', value: (r) => r.openingPaise, aggregate: 'sum', width: 150 },
  { id: 'deducted', header: 'Deducted', kind: 'money', value: (r) => r.deductedPaise, aggregate: 'sum', width: 140 },
  { id: 'deposited', header: 'Deposited', kind: 'money', value: (r) => r.depositedPaise, aggregate: 'sum', width: 140 },
  { id: 'outstanding', header: 'Outstanding', kind: 'money', value: (r) => r.outstandingPaise, aggregate: 'sum', width: 140 },
  { id: 'deductees', header: 'Deductees', kind: 'number', value: (r) => r.deductees, width: 104 },
  { id: 'entries', header: 'Per entries', kind: 'money', value: (r) => r.entriesTdsPaise, aggregate: 'sum', width: 140, defaultHidden: true }
])

export function TdsScreen(): React.JSX.Element {
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
    queryKey: ['tds', 'ledgerSummary', fyStartYear, quarter],
    queryFn: () => api.tds.ledgerSummary(fyStartYear, quarter)
  })
  const { data: eligible } = useQuery({
    queryKey: ['tds', 'eligible', period.from, period.to, false],
    queryFn: () => api.tds.eligible(period.from, period.to, false)
  })
  const rows = summary ?? []
  const total = (k: keyof Pick<TdsLedgerSummaryRow, 'openingPaise' | 'deductedPaise' | 'depositedPaise' | 'outstandingPaise'>): number =>
    rows.reduce((s, r) => s + r[k], 0)
  const eligibleCount = (eligible ?? []).filter((r) => !r.exemptReason).length

  return (
    <Page width="wide">
      <PageHeader
        title="TDS"
        period={period.label}
        tabs={
          <TabBar
            screen="tds"
            label="TDS views"
            tabs={[
              { id: 'eligible', label: 'Eligible', count: eligibleCount || undefined },
              { id: 'deducted', label: 'Deducted' },
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
            <Select value={fyStartYear} onChange={(e) => setFyStartYear(Number(e.target.value))} className="w-36" aria-label="Financial year" data-testid="input-tds-fy">
              {years.map((y) => (
                <option key={y} value={y}>
                  FY {fyFromStartYear(y).label}
                </option>
              ))}
            </Select>
            <Select value={quarter} onChange={(e) => setQuarter(Number(e.target.value) as QuarterChoice)} className="w-32" aria-label="Quarter" data-testid="input-tds-quarter">
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
          content: (
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
            <StatTile label="Payable at start" value={<Money paise={total('openingPaise')} />} testId="tds-stat-opening" />
            <StatTile label={`Deducted · ${period.label}`} value={<Money paise={total('deductedPaise')} />} tone="cr" testId="tds-stat-deducted" />
            <StatTile label="Deposited" value={<Money paise={total('depositedPaise')} />} tone="dr" testId="tds-stat-deposited" />
            <StatTile
              label="Outstanding"
              value={<Money paise={total('outstandingPaise')} />}
              tone="amber"
              hint={total('outstandingPaise') > 0 ? 'Due by the 7th of the next month (30 April for March)' : undefined}
              testId="tds-stat-outstanding"
            />
          </StatGrid>
        </div>
        <DataTable
          viewId="tds-ledger-summary"
          testId="tds-summary"
          ariaLabel={`TDS payable ledgers — ${period.label}`}
          columns={TDS_SUMMARY_COLUMNS}
          rows={rows}
          loading={isLoading}
          rowKey={(r) => r.sectionId}
          rowAttrs={(r) => ({ 'data-row-id': r.sectionId })}
          isRowActivatable={(r) => r.ledgerId != null}
          onRowActivate={(r) => r.ledgerId != null && openLedgerStatement(r.ledgerId)}
          maxHeight="none"
          toolbarFeatures={{ groupBy: false, views: false }}
          empty={{ title: `No TDS in ${period.label}`, hint: 'Payable ledgers appear here once a deduction is saved' }}
          exportOptions={{ title: 'TDS payable ledgers', periodLabel: period.label, filename: `tds-ledgers-${period.from}` }}
        />
      </Panel>

      {tab === 'eligible' && <EligibleTab period={period} />}
      {tab === 'deducted' && <DeductedTab period={period} />}
      {tab === 'challans' && <ChallansTab period={period} />}
      {tab === 'returns' && <ReturnsTab key={`${fyStartYear}-${quarter}`} fyStartYear={fyStartYear} initialQuarter={quarter} />}
      {tab === 'sections' && <SectionsTab />}
    </Page>
  )
}
