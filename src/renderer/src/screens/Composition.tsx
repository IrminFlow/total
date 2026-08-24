import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, SectionTitle, Select, SkeletonRows, useTableNav } from '../components/ui'
import { TabBar } from '../components/TabBar'
import { csvReport, printReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'
import { COMPOSITION_CATEGORIES, type CompositionCategory } from '@shared/gst/composition'
import { fyOf, fyFromStartYear, toDisplayDate, todayISO } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { periodBounds, periodKey } from '@shared/period'

/**
 * The composition scheme: CMP-08 and GSTR-4.
 *
 * Composition dealers used to reach a blocked GSTR-1 export and a message telling them their
 * scheme files something else, which the app then did not offer. This is that something else.
 *
 * The category selector is here rather than buried in settings because the rate is the single
 * number that decides the whole liability, and a dealer should be able to see it change.
 */
type Tab = 'cmp08' | 'gstr4'

const CMP08_COLUMNS: PdfColumn[] = [
  { label: 'Particulars', align: 'l' },
  { label: 'Amount', align: 'r' }
]

const GSTR4_COLUMNS: PdfColumn[] = [
  { label: 'Quarter', align: 'l' },
  { label: 'Turnover', align: 'r' },
  { label: 'CGST', align: 'r' },
  { label: 'SGST', align: 'r' },
  { label: 'Reverse charge', align: 'r' },
  { label: 'Payable', align: 'r' }
]

export function CompositionScreen(): React.JSX.Element {
  const { info, from, to } = useSession()
  const toast = useToasts()
  const [tab, setTab] = useState<Tab>('cmp08')
  const [category, setCategory] = useState<CompositionCategory>('trader')

  const today = todayISO()
  const fy = fyOf(from)
  // Default to the quarter the books' start date falls in, which is the one a dealer opening
  // this screen mid-year almost always wants.
  const [quarterKey, setQuarterKey] = useState(() => periodKey(today >= from && today <= to ? today : from, 'quarter'))
  const quarter = periodBounds(quarterKey, 'quarter')

  const isComposition = info?.gstRegistrationType === 'composition'

  const { data: cmp, isLoading: loadingCmp } = useQuery({
    queryKey: ['cmp08', quarterKey, category],
    queryFn: () => api.composition.cmp08(quarter.from, quarter.to, category),
    enabled: isComposition && tab === 'cmp08'
  })

  const { data: annual, isLoading: loadingAnnual } = useQuery({
    queryKey: ['gstr4', fy.startYear, category],
    queryFn: () => api.composition.gstr4(fy.startYear, category),
    enabled: isComposition && tab === 'gstr4'
  })

  const annualTable = useTableNav(annual?.quarters ?? [], { rowId: (q) => q.quarter })

  if (!isComposition) {
    return (
      <div className="mx-auto max-w-3xl">
        <SectionTitle>Composition scheme</SectionTitle>
        <Panel className="p-6">
          <EmptyState
            title="This company is not on the composition scheme"
            hint="Set the registration type to Composition in Company details to file CMP-08 and GSTR-4 here."
          />
        </Panel>
      </div>
    )
  }

  const quarters = ([1, 2, 3, 4] as const).map((q) => ({
    key: `${fy.startYear}-Q${q}`,
    label: `Q${q} · ${fyFromStartYear(fy.startYear).label}`
  }))

  const cmpRows: PdfRow[] = cmp
    ? [
        { cells: ['Outward turnover', formatPaise(cmp.outwardTurnover)] },
        { cells: [`Tax on turnover at ${cmp.ratePercent}%`, formatPaise(cmp.cgst + cmp.sgst)] },
        { cells: ['  of which CGST', formatPaise(cmp.cgst)] },
        { cells: ['  of which SGST', formatPaise(cmp.sgst)] },
        { cells: ['Reverse charge on inward supplies', formatPaise(cmp.reverseChargeTax)] },
        { cells: ['Interest', formatPaise(cmp.interest)] },
        { cells: ['Late fee', formatPaise(cmp.lateFee)] },
        { cells: ['Total payable', formatPaise(cmp.totalPayable)], bold: true, rule: true }
      ]
    : []

  const categorySelect = (
    <Select
      data-testid="select-composition-category"
      className="w-64"
      value={category}
      onChange={(e) => setCategory(e.target.value as CompositionCategory)}
    >
      {COMPOSITION_CATEGORIES.map((c) => (
        <option key={c.id} value={c.id}>
          {c.label} · {c.ratePercent}%
        </option>
      ))}
    </Select>
  )

  // Built once so the on-screen table, the PDF and the CSV cannot drift apart. The FY total row
  // is included: an exported return without its total is not a return.
  const gstr4Rows: PdfRow[] = annual
    ? [
        ...annual.quarters.map((q) => ({
          cells: [
            q.quarter,
            formatPaise(q.cmp08.outwardTurnover),
            formatPaise(q.cmp08.cgst),
            formatPaise(q.cmp08.sgst),
            formatPaise(q.cmp08.reverseChargeTax),
            formatPaise(q.cmp08.totalPayable)
          ]
        })),
        {
          cells: [
            `FY ${annual.financialYear}`,
            formatPaise(annual.totalTurnover),
            formatPaise(annual.totalCgst),
            formatPaise(annual.totalSgst),
            formatPaise(annual.totalReverseChargeTax),
            formatPaise(annual.totalPayable)
          ],
          bold: true,
          rule: true
        }
      ]
    : []

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle
        right={
          <TabBar
            screen="composition"
            tabs={[
              { id: 'cmp08', label: 'CMP-08' },
              { id: 'gstr4', label: 'GSTR-4' }
            ]}
            active={tab}
            onSelect={setTab}
          />
        }
      >
        {tab === 'cmp08' ? 'CMP-08 · quarterly statement' : 'GSTR-4 · annual return'}
      </SectionTitle>

      <p className="mb-4 max-w-prose text-body-sm text-muted">
        Under the composition scheme you charge no tax to your customer and claim no input credit.
        The liability is a percentage of turnover, paid out of your own margin.
      </p>

      {tab === 'cmp08' ? (
        <>
          <div className="mb-3 flex items-center gap-2">
            <Select data-testid="select-composition-quarter" className="w-48" value={quarterKey} onChange={(e) => setQuarterKey(e.target.value)}>
              {quarters.map((q) => (
                <option key={q.key} value={q.key}>
                  {q.label}
                </option>
              ))}
            </Select>
            {categorySelect}
            <span className="whitespace-nowrap text-hint text-muted">
              {toDisplayDate(quarter.from)} → {toDisplayDate(quarter.to)}
            </span>
            <span className="flex-1" />
            <Button
              variant="ghost"
              disabled={!cmp}
              onClick={() =>
                void printReport(
                  {
                    title: `CMP-08 · ${quarterKey}`,
                    periodLabel: `${toDisplayDate(quarter.from)} → ${toDisplayDate(quarter.to)}`,
                    columns: CMP08_COLUMNS,
                    rows: cmpRows,
                    filename: `cmp08-${quarterKey}`
                  },
                  toast
                )
              }
            >
              PDF
            </Button>
            <Button
              variant="ghost"
              disabled={!cmp}
              onClick={() =>
                void csvReport(
                  CMP08_COLUMNS.map((c) => c.label),
                  cmpRows.map((r) => r.cells),
                  `cmp08-${quarterKey}`,
                  toast
                )
              }
            >
              CSV
            </Button>
          </div>

          <Panel>
            {loadingCmp || !cmp ? (
              <SkeletonRows rows={6} />
            ) : (
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>Particulars</th>
                    <th className="r w-48">Amount</th>
                  </tr>
                </thead>
                <tbody data-testid="rows-cmp08">
                  <tr>
                    <td>Outward turnover</td>
                    <td className="r"><Money paise={cmp.outwardTurnover} /></td>
                  </tr>
                  <tr>
                    <td>Tax on turnover at {cmp.ratePercent}%</td>
                    <td className="r"><Money paise={cmp.cgst + cmp.sgst} /></td>
                  </tr>
                  <tr>
                    <td className="pl-8 text-muted">CGST</td>
                    <td className="r"><Money paise={cmp.cgst} /></td>
                  </tr>
                  <tr>
                    <td className="pl-8 text-muted">SGST</td>
                    <td className="r"><Money paise={cmp.sgst} /></td>
                  </tr>
                  <tr>
                    <td>
                      Reverse charge on inward supplies
                      <span className="ml-2 text-hint text-muted">at the normal rate, not the composition rate</span>
                    </td>
                    <td className="r"><Money paise={cmp.reverseChargeTax} /></td>
                  </tr>
                  <tr className="total-row">
                    <td>Total payable</td>
                    <td className="r"><Money paise={cmp.totalPayable} /></td>
                  </tr>
                </tbody>
              </table>
            )}
          </Panel>
        </>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2">
            {categorySelect}
            <span className="whitespace-nowrap text-hint text-muted">FY {fy.label}</span>
            <span className="flex-1" />
            <Button
              variant="ghost"
              disabled={!annual?.quarters.length}
              onClick={() =>
                void printReport(
                  {
                    title: `GSTR-4 · FY ${fy.label}`,
                    periodLabel: annual?.missingQuarters.length
                      ? `${annual.quarters.map((q) => q.quarter).join(', ')} — ${annual.missingQuarters.join(', ')} not started`
                      : 'Q1 to Q4',
                    columns: GSTR4_COLUMNS,
                    rows: gstr4Rows,
                    filename: `gstr4-${fy.label}`
                  },
                  toast
                )
              }
            >
              PDF
            </Button>
            <Button
              variant="ghost"
              disabled={!annual?.quarters.length}
              onClick={() =>
                void csvReport(
                  GSTR4_COLUMNS.map((c) => c.label),
                  gstr4Rows.map((r) => r.cells),
                  `gstr4-${fy.label}`,
                  toast
                )
              }
            >
              CSV
            </Button>
          </div>
          {annual && annual.missingQuarters.length > 0 && (
            <div className="mb-3 rounded-md border border-amber/50 bg-amber/10 px-3.5 py-2.5 text-body-sm text-amber">
              {annual.missingQuarters.join(' and ')}{' '}
              {annual.missingQuarters.length > 1 ? 'have' : 'has'} not started yet — this return covers{' '}
              {annual.quarters.length} of 4 quarters. A quarter with no sales still files a nil CMP-08.
            </div>
          )}
          <Panel>
            {loadingAnnual || !annual ? (
              <SkeletonRows rows={5} />
            ) : annual.quarters.length === 0 ? (
              <EmptyState title="No composition entries this financial year" />
            ) : (
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>Quarter</th>
                    <th className="r w-32">Turnover</th>
                    <th className="r w-28">CGST</th>
                    <th className="r w-28">SGST</th>
                    <th className="r w-32">Reverse charge</th>
                    <th className="r w-32">Payable</th>
                  </tr>
                </thead>
                <tbody data-testid="rows-gstr4">
                  {annual.quarters.map((q, i) => (
                    <tr key={q.quarter} {...annualTable.rowProps(i, q)}>
                      <td>{q.quarter}</td>
                      <td className="r"><Money paise={q.cmp08.outwardTurnover} /></td>
                      <td className="r"><Money paise={q.cmp08.cgst} /></td>
                      <td className="r"><Money paise={q.cmp08.sgst} /></td>
                      <td className="r"><Money paise={q.cmp08.reverseChargeTax} /></td>
                      <td className="r"><Money paise={q.cmp08.totalPayable} /></td>
                    </tr>
                  ))}
                  <tr className="total-row">
                    <td>FY {annual.financialYear}</td>
                    <td className="r"><Money paise={annual.totalTurnover} /></td>
                    <td className="r"><Money paise={annual.totalCgst} /></td>
                    <td className="r"><Money paise={annual.totalSgst} /></td>
                    <td className="r"><Money paise={annual.totalReverseChargeTax} /></td>
                    <td className="r"><Money paise={annual.totalPayable} /></td>
                  </tr>
                </tbody>
              </table>
            )}
          </Panel>
        </>
      )}
    </div>
  )
}
