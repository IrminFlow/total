// GSTR-9 annual-return workings (WP 3.4): tables 4–18 from the year's vouchers with a drill-down
// to the vouchers behind each row, Table 9 (tax paid, Σ the monthly 3B), and the comparison of
// the year against Σ the monthly GSTR-1 / GSTR-3B (the exported JSON where a month was exported,
// else rebuilt from the books) — differences highlighted.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fyOf, todayISO, toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { GSTR9_RULES } from '@shared/gst/sources'
import type { Gstr9Compare, Gstr9DocRef, Gstr9PaidRow, Gstr9Row } from '@shared/gst/gstr9'
import type { Gstr9View } from '@shared/gst/views'
import { api } from '../../lib/client'
import { useToasts } from '../../state/stores'
import { Badge, Banner, Button, DrawerSection, Page, PageHeader, Panel } from '../../components/ui'
import { OptionsTable } from '../../components/ScreenOptions'
import { DataTable, defineColumns } from '../../components/table'
import { LedgerLink, VoucherLink } from '../../components/links'
import { openVoucher } from '../../lib/drill'
import { GstReturnTabs } from '../GstReturns'
import { FySelect, SourcesSection, UnverifiedBanner } from './common'

const SOURCE_BADGE: Record<Gstr9Row['source'], { label: string; tone: 'neutral' | 'info' | 'warning' }> = {
  books: { label: 'Vouchers', tone: 'neutral' },
  returns: { label: 'Σ 3B', tone: 'info' },
  manual: { label: '3B adj.', tone: 'info' },
  na: { label: 'Fill on portal', tone: 'warning' }
}

const diffTotal = (c: Gstr9Compare): number => c.diff.taxable + c.diff.igst + c.diff.cgst + c.diff.sgst + c.diff.cess
const tax = (a: { igst: number; cgst: number; sgst: number; cess: number }): number => a.igst + a.cgst + a.sgst + a.cess

export const GSTR9_COMPARE_COLUMNS = defineColumns<Gstr9Compare>([
  { id: 'against', header: 'Against', kind: 'enum', value: (c) => c.against, options: [{ value: 'GSTR-1', label: 'GSTR-1' }, { value: 'GSTR-3B', label: 'GSTR-3B' }], width: 96 },
  { id: 'label', header: 'Particulars', kind: 'text', value: (c) => c.label, hideable: false, groupable: false, minWidth: 330 },
  { id: 'annualTaxable', header: 'Taxable', group: 'GSTR-9 (year)', kind: 'money', value: (c) => (c.hasTaxable ? c.annual.taxable : null), width: 120 },
  { id: 'annualTax', header: 'Tax', group: 'GSTR-9 (year)', kind: 'money', value: (c) => tax(c.annual), width: 108 },
  { id: 'monthlyTaxable', header: 'Taxable', group: 'Σ monthly', kind: 'money', value: (c) => (c.hasTaxable ? c.monthly.taxable : null), width: 120 },
  { id: 'monthlyTax', header: 'Tax', group: 'Σ monthly', kind: 'money', value: (c) => tax(c.monthly), width: 108 },
  { id: 'diffTaxable', header: 'Taxable', group: 'Difference', kind: 'money', signed: true, value: (c) => (c.hasTaxable ? c.diff.taxable : null), width: 112 },
  { id: 'diffTax', header: 'Tax', group: 'Difference', kind: 'money', signed: true, value: (c) => tax(c.diff), width: 100 }
])

export const GSTR9_ROW_COLUMNS = defineColumns<Gstr9Row>([
  { id: 'table', header: 'Table', kind: 'text', value: (r) => `Table ${r.table}`, width: 92, groupKey: (r) => `Table ${r.table}`, defaultHidden: true },
  { id: 'row', header: 'Row', kind: 'text', value: (r) => r.id, width: 64, className: 'num' },
  { id: 'label', header: 'Particulars', kind: 'text', value: (r) => r.label, hideable: false, groupable: false, minWidth: 380,
    cell: (r) => (
      <span className={r.kind === 'subtotal' ? 'font-medium' : ''}>
        {r.label}
        {r.note && <span className="ml-1 text-hint text-muted" title={r.note}>ⓘ</span>}
      </span>
    ) },
  { id: 'taxable', header: 'Taxable', kind: 'money', value: (r) => (r.hasTaxable ? r.amounts.taxable : null), width: 128 },
  { id: 'igst', header: 'IGST', kind: 'money', value: (r) => r.amounts.igst, width: 108 },
  { id: 'cgst', header: 'CGST', kind: 'money', value: (r) => r.amounts.cgst, width: 108 },
  { id: 'sgst', header: 'SGST', kind: 'money', value: (r) => r.amounts.sgst, width: 108 },
  { id: 'cess', header: 'Cess', kind: 'money', value: (r) => r.amounts.cess, width: 84 },
  { id: 'docs', header: 'Vouchers', kind: 'number', value: (r) => r.docs.length, width: 88, defaultHidden: true },
  { id: 'source', header: 'From', kind: 'enum', value: (r) => r.source, width: 118,
    options: Object.entries(SOURCE_BADGE).map(([value, b]) => ({ value, label: b.label })),
    // Vouchers is the norm — only the exceptions carry a badge.
    cell: (r) => (r.source === 'books' ? <span className="text-hint text-muted">Vouchers</span> : <Badge tone={SOURCE_BADGE[r.source].tone} title={r.note}>{SOURCE_BADGE[r.source].label}</Badge>) }
])

const DOC_COLUMNS = defineColumns<Gstr9DocRef>([
  { id: 'date', header: 'Date', kind: 'date', value: (d) => d.date, className: 'text-muted' },
  { id: 'number', header: 'Voucher', kind: 'text', value: (d) => d.number, width: 120, cell: (d) => <VoucherLink voucherId={d.voucherId} label={d.number} /> },
  { id: 'party', header: 'Party', kind: 'text', value: (d) => d.partyName, minWidth: 160, cell: (d) => (d.partyName ? <LedgerLink ledgerId={d.partyLedgerId} name={d.partyName} /> : <span className="text-muted">—</span>) },
  { id: 'taxable', header: 'Taxable', kind: 'money', value: (d) => d.taxable, aggregate: 'sum', width: 124 },
  { id: 'tax', header: 'Tax', kind: 'money', value: (d) => tax(d), aggregate: 'sum', width: 112 }
])

export const GSTR9_PAID_COLUMNS = defineColumns<Gstr9PaidRow>([
  { id: 'label', header: 'Description', kind: 'text', value: (r) => r.label, hideable: false, groupable: false, minWidth: 150 },
  { id: 'payable', header: 'Tax payable', kind: 'money', value: (r) => r.payable, width: 128 },
  { id: 'cash', header: 'Paid through cash', kind: 'money', value: (r) => r.paidCash, width: 140 },
  { id: 'itcC', header: 'Central', group: 'Paid through ITC', kind: 'money', value: (r) => r.paidItc.cgst, width: 112 },
  { id: 'itcS', header: 'State/UT', group: 'Paid through ITC', kind: 'money', value: (r) => r.paidItc.sgst, width: 112 },
  { id: 'itcI', header: 'Integrated', group: 'Paid through ITC', kind: 'money', value: (r) => r.paidItc.igst, width: 112 },
  { id: 'itcX', header: 'Cess', group: 'Paid through ITC', kind: 'money', value: (r) => r.paidItc.cess, width: 96 },
  { id: 'total', header: 'Total paid', kind: 'money', value: (r) => r.paidCash + r.paidItc.cgst + r.paidItc.sgst + r.paidItc.igst + r.paidItc.cess, width: 124 },
  { id: 'diff', header: 'Difference', kind: 'money', signed: true, value: (r) => r.payable - (r.paidCash + r.paidItc.cgst + r.paidItc.sgst + r.paidItc.igst + r.paidItc.cess), width: 116 }
])

function Thresholds({ r }: { r: Gstr9View }): React.JSX.Element {
  const exported = r.months.filter((m) => m.source === 'exported').length
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-small text-muted" data-testid="gstr9-facts">
      <Badge tone="neutral">Due {toDisplayDate(r.dueDate)} (rule 80)</Badge>
      <span>Turnover {formatPaise(r.turnover, { symbol: true })}</span>
      {r.optional && <Badge tone="info" title="Notification 15/2025-CT (FY 2024-25 onwards)">Optional — turnover up to {formatPaise(GSTR9_RULES.exemptUptoPaise, { symbol: true })}</Badge>}
      {r.gstr9cApplies && <Badge tone="warning" title="Rule 80(3) — self-certified reconciliation statement">GSTR-9C applies (above ₹5 crore) — not prepared here</Badge>}
      <span>
        Months compared: {exported} against the exported JSON, {r.months.length - exported} rebuilt from the books
      </span>
    </div>
  )
}

export function Gstr9Screen(): React.JSX.Element {
  const toast = useToasts()
  const [fy, setFy] = useState(() => fyOf(todayISO()).startYear)
  const { data, isLoading } = useQuery({ queryKey: ['gstr9', fy], queryFn: () => api.gst.gstr9(fy) })
  const diffs = (data?.compare ?? []).filter((c) => diffTotal(c) !== 0)

  const doExport = async (): Promise<void> => {
    try {
      const r = await api.gst.exportGstr9(fy)
      toast.push('success', `GSTR-9 workings saved — ${r.csvPath.split('/').pop()} and JSON`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Page width="wide">
      <PageHeader
        title="GSTR-9 · Annual return workings"
        tabs={<GstReturnTabs current="gstr9" />}
        controls={<FySelect value={fy} onChange={setFy} testId="input-gstr9-fy" />}
        actions={
          <Button variant="primary" data-testid="btn-gstr9-export" onClick={() => void doExport()} disabled={!data}>
            Export CSV + JSON
          </Button>
        }
        options={{
          content: (
            <>
              <OptionsTable area="gstr9" label="Tables" />
              <DrawerSection title="How the comparison works">
                <p className="text-hint text-muted">
                  The tables are computed from the year&apos;s vouchers. Each month&apos;s GSTR-1 / GSTR-3B is the JSON you exported for it (a
                  snapshot is kept at export), or — for months never exported — rebuilt from the books now. A difference means the books
                  changed after a month was exported. Rows marked &ldquo;Fill on portal&rdquo; (amendments, Table 8A from GSTR-2B, transition
                  credit) cannot be derived offline.
                </p>
              </DrawerSection>
              <SourcesSection ids={GSTR9_RULES.sources} />
            </>
          )
        }}
      />

      <UnverifiedBanner ids={['gstr9-layout', 'gstr9-json', 'gstr9-exempt']} testId="gstr9-unverified" />
      {data && <Thresholds r={data} />}

      {data && (
        <Banner tone={diffs.length ? 'warning' : 'success'} className="mb-3" testId="gstr9-compare-status">
          {diffs.length
            ? `${diffs.length} line${diffs.length > 1 ? 's' : ''} differ from Σ the monthly returns — highlighted below.`
            : 'The year ties to Σ the monthly GSTR-1 and GSTR-3B on every line.'}
        </Banner>
      )}

      <Panel className="mb-section">
        <p className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">Year vs Σ monthly returns</p>
        <DataTable
          viewId="gstr9-compare"
          testId="gstr9-compare"
          ariaLabel="GSTR-9 compared with the monthly returns"
          columns={GSTR9_COMPARE_COLUMNS}
          rows={data?.compare ?? []}
          rowKey={(c) => c.id}
          rowAttrs={(c) => ({ 'data-compare': c.id, 'data-diff': diffTotal(c) !== 0 ? 'yes' : 'no' })}
          rowClassName={(c) => (diffTotal(c) !== 0 ? 'bg-warning-soft text-warning' : '')}
          loading={isLoading}
          totals={false}
          maxHeight="none"
          exportOptions={{ title: 'GSTR-9 comparison', periodLabel: data ? `FY ${data.fyLabel}` : '', filename: `gstr9-compare-${fy}` }}
        />
      </Panel>

      <Panel className="mb-section">
        <p className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">Tables 4–18 (open a row for its vouchers)</p>
        <DataTable
          viewId="gstr9-rows"
          testId="gstr9"
          ariaLabel="GSTR-9 tables"
          columns={GSTR9_ROW_COLUMNS}
          rows={data?.rows ?? []}
          rowKey={(r) => r.id}
          rowAttrs={(r) => ({ 'data-row': r.id })}
          rowClassName={(r) => (r.kind === 'subtotal' ? 'font-medium' : r.source === 'na' ? 'text-muted' : '')}
          isRowExpandable={(r) => r.docs.length > 0}
          renderDetail={(r) => (
            <div className="px-2 py-1">
              <DataTable
                testId={`gstr9-docs-${r.id.toLowerCase()}`}
                ariaLabel={`Vouchers in ${r.id}`}
                columns={DOC_COLUMNS}
                rows={r.docs}
                rowKey={(d) => `${d.voucherId}`}
                rowAttrs={(d) => ({ 'data-row-id': d.voucherId })}
                onRowActivate={(d) => openVoucher(d.voucherId)}
                toolbar={false}
                maxHeight="18rem"
              />
            </div>
          )}
          loading={isLoading}
          totals={false}
          maxHeight="calc(100vh - 260px)"
          exportOptions={{ title: 'GSTR-9 workings', periodLabel: data ? `FY ${data.fyLabel}` : '', filename: `gstr9-${fy}` }}
        />
      </Panel>

      <Panel className="mb-section">
        <p className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">Table 9 — tax paid as declared in the year&apos;s returns</p>
        <DataTable
          viewId="gstr9-paid"
          testId="gstr9-paid"
          ariaLabel="GSTR-9 Table 9"
          columns={GSTR9_PAID_COLUMNS}
          rows={data?.paid ?? []}
          rowKey={(r) => r.id}
          loading={isLoading}
          totals={false}
          maxHeight="none"
          exportOptions={{ title: 'GSTR-9 Table 9', periodLabel: data ? `FY ${data.fyLabel}` : '', filename: `gstr9-table9-${fy}` }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">Workings for review and hand entry on the portal — the JSON is the app&apos;s own layout, not a portal upload · F12 for options and sources.</p>
    </Page>
  )
}
