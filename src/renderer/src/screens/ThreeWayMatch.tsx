// Three-way match (WP 2.5d): purchase bills and GRNs dated in the working period checked line by
// line against their GRN / PO — rate or amount off beyond the tolerances, received but billed in
// part, billed with no GRN, GRNs with no PO (and, optionally, bill lines drawn from nothing). The
// tolerances live in Options (F12) and are saved per company. Every document is a link.
import { useQuery } from '@tanstack/react-query'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import {
  DEFAULT_MATCH_TOLERANCES, MATCH_EXCEPTION_LABELS, MATCH_EXCEPTIONS, type MatchException, type MatchLineRef, type MatchRow
} from '@shared/tradeCycle/match'
import { api } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { Badge, Button, DrawerSection, Field, Page, PageHeader, Panel, StatGrid, StatTile, TextInput } from '../components/ui'
import type { BadgeTone } from '../components/kit/Badge'
import { OptionToggle, OptionsPeriod, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { ItemLink, LedgerLink, TradeDocLink, VoucherLink } from '../components/links'
import { openLinkedDocs } from '../components/LinkedDocs'

const TONE: Record<MatchException, BadgeTone> = {
  rate_variance: 'danger', qty_unbilled: 'amber', bill_without_grn: 'warning', grn_without_po: 'info', unmatched_bill_line: 'neutral'
}

const refCell = (r: MatchLineRef | null, kind: 'po' | 'grn' | 'bill'): React.ReactNode => {
  if (!r) return <span className="text-muted">—</span>
  const label = <span className="num">{r.number}</span>
  return kind === 'po' ? <TradeDocLink tradeDocId={r.tradeDocId} kind="purchase_order" label={label} /> : <VoucherLink voucherId={r.voucherId} label={label} />
}

const rateOf = (r: MatchLineRef | null): number | null => (r && r.qtyMilli > 0 ? Math.round((r.amount * 1000) / r.qtyMilli) : null)

const COLUMNS = defineColumns<MatchRow>([
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted' },
  {
    id: 'exception', header: 'Exception', kind: 'enum', value: (r) => r.exception, width: 190, hideable: false,
    options: MATCH_EXCEPTIONS.map((e) => ({ value: e, label: MATCH_EXCEPTION_LABELS[e] })),
    text: (r) => MATCH_EXCEPTION_LABELS[r.exception],
    cell: (r) => <Badge tone={TONE[r.exception]} testId="match-exception">{MATCH_EXCEPTION_LABELS[r.exception]}</Badge>
  },
  {
    id: 'party', header: 'Supplier', kind: 'text', value: (r) => r.partyName ?? '', minWidth: 140,
    cell: (r) => (r.partyLedgerId ? <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName ?? ''} /> : <>{r.partyName}</>)
  },
  { id: 'item', header: 'Item', kind: 'text', value: (r) => r.itemName, minWidth: 120, cell: (r) => <ItemLink itemId={r.stockItemId} name={r.itemName} /> },
  { id: 'po', header: 'PO', kind: 'text', value: (r) => r.po?.number ?? '', width: 92, cell: (r) => refCell(r.po, 'po') },
  { id: 'grn', header: 'GRN', kind: 'text', value: (r) => r.grn?.number ?? '', width: 92, cell: (r) => refCell(r.grn, 'grn') },
  { id: 'bill', header: 'Bill', kind: 'text', value: (r) => r.bill?.number ?? '', width: 92, cell: (r) => refCell(r.bill, 'bill') },
  { id: 'poRate', header: 'PO rate', kind: 'money', value: (r) => rateOf(r.po), width: 104, defaultHidden: true },
  { id: 'grnRate', header: 'GRN rate', kind: 'money', value: (r) => rateOf(r.grn), width: 104, defaultHidden: true },
  { id: 'billRate', header: 'Bill rate', kind: 'money', value: (r) => rateOf(r.bill), width: 104, defaultHidden: true },
  { id: 'qty', header: 'Qty', kind: 'quantity', value: (r) => (r.diffQtyMilli || null), decimals: (r) => r.decimals, width: 84 },
  { id: 'expected', header: 'Expected', kind: 'money', value: (r) => r.expectedPaise, width: 120 },
  { id: 'actual', header: 'Actual', kind: 'money', value: (r) => r.actualPaise, width: 120 },
  {
    id: 'diff', header: 'Difference', kind: 'money', value: (r) => r.diffPaise, width: 124, aggregate: 'sum',
    cell: (r) => <span className={`num ${r.exception === 'rate_variance' ? (r.diffPaise > 0 ? 'text-cr' : 'text-dr') : ''}`}>{formatPaise(r.diffPaise)}</span>
  },
  { id: 'pct', header: 'Diff %', kind: 'number', value: (r) => (r.diffBp == null ? null : r.diffBp / 100), text: (r) => (r.diffBp == null ? '' : `${(r.diffBp / 100).toFixed(2)} %`), width: 84 }
])

interface Opts extends Record<string, unknown> {
  ratePct: string
  amountRupees: string
  qtyPct: string
  flagGrnWithoutPo: boolean
  flagUnmatchedBills: boolean
}

const toBp = (s: string): number => Math.max(0, Math.min(10_000, Math.round((parseFloat(s) || 0) * 100)))

export function ThreeWayMatchScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const opts = useScreenOptions<Opts>('three-way-match', {
    ratePct: '0', amountRupees: String(DEFAULT_MATCH_TOLERANCES.amountTolPaise / 100), qtyPct: '0', flagGrnWithoutPo: true, flagUnmatchedBills: false
  })
  const o = opts.options
  const tolerances = {
    rateTolBp: toBp(o.ratePct),
    amountTolPaise: Math.max(0, Math.round((parseFloat(o.amountRupees) || 0) * 100)),
    qtyTolBp: toBp(o.qtyPct),
    flagGrnWithoutPo: o.flagGrnWithoutPo,
    flagUnmatchedBills: o.flagUnmatchedBills
  }
  const { data, isLoading } = useQuery({
    queryKey: ['tradeMatch', from, to, tolerances],
    queryFn: () => api.trade.threeWayMatch({ from, to, ...tolerances })
  })
  const rows = data ?? []
  const periodLabel = `${toDisplayDate(from)} to ${toDisplayDate(to)}`
  const count = (e: MatchException): number => rows.filter((r) => r.exception === e).length
  const variance = rows.filter((r) => r.exception === 'rate_variance').reduce((s, r) => s + r.diffPaise, 0)
  return (
    <Page width="wide">
      <PageHeader
        title="Three-way match"
        period={periodLabel}
        actions={<Button onClick={() => nav.go({ name: 'pending-grns' })}>Pending GRNs</Button>}
        options={{
          onReset: opts.reset,
          content: (
            <>
              <OptionsPeriod note="Bills and GRNs dated in the working period are checked; the POs and GRNs they draw on may be older." />
              <DrawerSection title="Tolerances" testId="match-tolerances">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Rate / amount, %" hint="Share of the agreed amount">
                    <TextInput value={o.ratePct} inputMode="decimal" className="num text-right" onChange={(e) => opts.set('ratePct', e.target.value)} data-testid="input-match-rate-pct" />
                  </Field>
                  <Field label="Rate / amount, ₹" hint="Flat, for rounding">
                    <TextInput value={o.amountRupees} inputMode="decimal" className="num text-right" onChange={(e) => opts.set('amountRupees', e.target.value)} data-testid="input-match-amount" />
                  </Field>
                  <Field label="Quantity, %" hint="Unbilled share of a GRN line">
                    <TextInput value={o.qtyPct} inputMode="decimal" className="num text-right" onChange={(e) => opts.set('qtyPct', e.target.value)} data-testid="input-match-qty-pct" />
                  </Field>
                </div>
                <p className="text-hint text-muted">A difference is an exception only when it is above both the % and the ₹ tolerance.</p>
              </DrawerSection>
              <DrawerSection title="Also flag">
                <OptionToggle label="GRNs with no purchase order" checked={o.flagGrnWithoutPo} onChange={(v) => opts.set('flagGrnWithoutPo', v)} testId="input-match-grn-no-po" />
                <OptionToggle
                  label="Bill lines with no PO or GRN"
                  hint="Off by default — every bill entered without orders would show."
                  checked={o.flagUnmatchedBills}
                  onChange={(v) => opts.set('flagUnmatchedBills', v)}
                  testId="input-match-unmatched"
                />
              </DrawerSection>
              <OptionsTable area="three-way-match" />
              <DrawerSection title="How it matches">
                <p className="text-hint text-muted">
                  Each bill line is compared with the line it was drawn from: through its GRN to the PO when there is one (the PO rate is the
                  agreed price), else with the GRN. The expected amount is the source line&apos;s value for the billed quantity (discount
                  included). A GRN line billed in part shows the unbilled quantity; one not billed at all is simply pending (Pending GRNs).
                  Over-billing can&apos;t happen — a bill never takes more than the GRN line holds.
                </p>
              </DrawerSection>
            </>
          )
        }}
      />
      <StatGrid className="mb-section">
        <StatTile label="Exceptions" value={String(rows.length)} hint={periodLabel} testId="match-count" />
        <StatTile label="Rate / amount" value={String(count('rate_variance'))} hint={`net ${formatPaise(variance, { symbol: true })}`} />
        <StatTile label="Billed in part" value={String(count('qty_unbilled'))} hint="received, not fully billed" />
        <StatTile label="No GRN / no PO" value={String(count('bill_without_grn') + count('grn_without_po'))} hint="missing a step" />
      </StatGrid>
      <Panel>
        <DataTable
          viewId="three-way-match"
          testId="three-way-match"
          ariaLabel="Three-way match exceptions"
          columns={COLUMNS}
          rows={rows}
          rowKey={(r) => r.key}
          rowAttrs={(r) => ({ 'data-exception': r.exception })}
          loading={isLoading}
          onRowActivate={(r) => {
            const v = r.bill?.voucherId ?? r.grn?.voucherId
            if (v) openLinkedDocs({ voucherId: v })
            else if (r.po?.tradeDocId) openLinkedDocs({ tradeDocId: r.po.tradeDocId })
          }}
          empty={{ title: 'Everything matches', hint: 'No bill or GRN in the period is outside the tolerances.' }}
          exportOptions={{ title: 'Three-way match exceptions', periodLabel, filename: 'three-way-match' }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">Click a row for its linked documents · document numbers open them · F12 for tolerances.</p>
    </Page>
  )
}
