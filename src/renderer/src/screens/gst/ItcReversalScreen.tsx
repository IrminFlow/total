// ITC reversal workings (WP 3.4) for one GSTR-3B month: rule 42 (common credit × E/F), rule 43
// (capital goods, Tc/60 × E/F), rule 37 (bills unpaid 180 days — reversal with interest,
// re-availment on payment), s.17(5) blocked credit; the Table 4(B)/4(D)(1)/5.1 figures, "Apply to
// GSTR-3B", and a one-click journal posted through the normal voucher save.
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fyOf, toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { RULE37_RULES, RULE42_RULES } from '@shared/gst/sources'
import { RULE37_INTEREST_NOTE, type CapitalGood, type Rule37Event } from '@shared/gst/itcReversal'
import type { ItcReversalInputs } from '@shared/gst/expansionSchemas'
import type { ItcReversalView, ProposalView } from '@shared/gst/views'
import { api } from '../../lib/client'
import { useToasts } from '../../state/stores'
import { AmountInput, Banner, Button, Checkbox, DrawerSection, Money, Page, PageHeader, Panel, SkeletonRows, StatGrid, StatTile } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { LedgerLink, VoucherLink } from '../../components/links'
import { openVoucher } from '../../lib/drill'
import { confirmDialog } from '../../lib/dialogs'
import { GstReturnTabs, MonthBar, NoMonths, useMonth } from '../GstReturns'
import { HEAD_COLUMNS, HeadsRow, SourcesSection, UnverifiedBanner, sumHeads, type HeadAmounts } from './common'

const R37_COLUMNS = defineColumns<Rule37Event>([
  { id: 'bill', header: 'Bill', kind: 'text', value: (e) => e.bill.number, width: 110, hideable: false, groupable: false, cell: (e) => <VoucherLink voucherId={e.bill.voucherId} label={e.bill.number} /> },
  { id: 'date', header: 'Bill date', kind: 'date', value: (e) => e.bill.date, className: 'text-muted' },
  { id: 'party', header: 'Supplier', kind: 'text', value: (e) => e.bill.partyName, minWidth: 150, cell: (e) => <LedgerLink ledgerId={e.bill.partyLedgerId} name={e.bill.partyName} /> },
  { id: 'ref', header: 'Supplier ref', kind: 'text', value: (e) => e.bill.supplierRef, width: 110, defaultHidden: true },
  { id: 'day180', header: '180th day', kind: 'date', value: (e) => e.day180, className: 'text-muted' },
  { id: 'amount', header: 'Bill amount', kind: 'money', value: (e) => e.bill.billAmount, width: 120 },
  { id: 'unpaid', header: 'Unpaid at 180 days', kind: 'money', value: (e) => e.bill.unpaidAt180, width: 140 },
  { id: 'reversed', header: 'Reversed', kind: 'money', value: (e) => sumHeads(e.reversed), aggregate: 'sum', width: 116 },
  { id: 'reclaimed', header: 'Re-availed', kind: 'money', value: (e) => sumHeads(e.reclaimed), aggregate: 'sum', width: 116 },
  { id: 'interest', header: 'Interest', kind: 'money', value: (e) => sumHeads(e.interest), aggregate: 'sum', width: 104 },
  { id: 'days', header: 'Days', kind: 'number', value: (e) => e.interestDays || null, width: 72, defaultHidden: true }
])

type GoodRow = CapitalGood & { monthsUsed: number; inLife: boolean }
const R43_COLUMNS = defineColumns<GoodRow>([
  { id: 'voucher', header: 'Purchase', kind: 'text', value: (g) => g.number, width: 110, hideable: false, groupable: false, cell: (g) => <VoucherLink voucherId={g.voucherId} label={g.number} /> },
  { id: 'date', header: 'Date', kind: 'date', value: (g) => g.date, className: 'text-muted' },
  { id: 'party', header: 'Supplier', kind: 'text', value: (g) => g.partyName, minWidth: 140 },
  { id: 'itc', header: 'ITC (A)', kind: 'money', value: (g) => sumHeads(g.itc), aggregate: 'sum', width: 120 },
  { id: 'months', header: 'Month of life', kind: 'number', value: (g) => g.monthsUsed, width: 110, text: (g) => `${g.monthsUsed} / ${RULE42_RULES.capitalGoodsLifeMonths}` },
  { id: 'common', header: 'Common use', kind: 'enum', value: (g) => (g.common ? 'yes' : 'no'), width: 112, options: [{ value: 'yes', label: 'Common' }, { value: 'no', label: 'Exclusively taxable' }] }
])

type BlockedRow = ItcReversalView['blocked'][number]
const BLOCKED_COLUMNS = defineColumns<BlockedRow>([
  { id: 'voucher', header: 'Purchase', kind: 'text', value: (b) => b.number, width: 110, hideable: false, groupable: false, cell: (b) => <VoucherLink voucherId={b.voucherId} label={b.number} /> },
  { id: 'date', header: 'Date', kind: 'date', value: (b) => b.date, className: 'text-muted' },
  { id: 'party', header: 'Supplier', kind: 'text', value: (b) => b.partyName, minWidth: 150, cell: (b) => (b.partyName ? <LedgerLink ledgerId={b.partyLedgerId} name={b.partyName} /> : null) },
  { id: 'tax', header: 'Blocked credit', kind: 'money', value: (b) => sumHeads(b.tax), aggregate: 'sum', width: 132 }
])

const PROPOSAL_COLUMNS = defineColumns<ProposalView>([
  { id: 'ledger', header: 'Ledger', kind: 'text', value: (l) => l.ledger.name, minWidth: 200, hideable: false, groupable: false,
    cell: (l) => (l.ledger.ledgerId != null ? <LedgerLink ledgerId={l.ledger.ledgerId} name={l.ledger.name} /> : <span>{l.ledger.name} <span className="text-hint text-muted">(created under {l.ledger.group} on post)</span></span>) },
  { id: 'dr', header: 'Debit', kind: 'money', value: (l) => (l.drCr === 'dr' ? l.amount : null), aggregate: 'sum', width: 132 },
  { id: 'cr', header: 'Credit', kind: 'money', value: (l) => (l.drCr === 'cr' ? l.amount : null), aggregate: 'sum', width: 132 }
])


/** T1 / T2 / T4 entry per head. */
function HeadsInput({ label, value, onChange, testId }: { label: string; value: HeadAmounts; onChange: (v: HeadAmounts) => void; testId: string }): React.JSX.Element {
  return (
    <tr>
      <td>{label}</td>
      {HEAD_COLUMNS.map((h) => (
        <td key={h.key} className="r">
          <AmountInput paise={value[h.key]} onPaise={(p) => onChange({ ...value, [h.key]: p ?? 0 })} testId={`${testId}-${h.key}`} ariaLabel={`${label} — ${h.label}`} />
        </td>
      ))}
    </tr>
  )
}

export function ItcReversalScreen(): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const { months, month, monthKey, setMonthKey } = useMonth('previous')
  const { data, isLoading } = useQuery({
    queryKey: ['itcReversal', month?.key],
    queryFn: () => api.gst.itcReversal(month!.from, month!.to, month!.period),
    enabled: !!month
  })
  const [draft, setDraft] = useState<ItcReversalInputs | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => setDraft(null), [month?.key])
  const inputs = draft ?? data?.inputs ?? null
  const dirty = draft != null && JSON.stringify(draft) !== JSON.stringify(data?.inputs)

  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['itcReversal'] })
    await qc.invalidateQueries({ queryKey: ['gstr3b'] })
    await qc.invalidateQueries({ queryKey: ['gst3bManual'] })
  }
  const run = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      await refresh()
      toast.push('success', ok)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!month) {
    return (
      <Page>
        <PageHeader title="ITC reversal workings" tabs={<GstReturnTabs current="itc-reversal" />} />
        <NoMonths />
      </Page>
    )
  }

  const s = data?.summary
  const post = async (): Promise<void> => {
    if (!data) return
    const ok = await confirmDialog({
      title: 'Post the ITC reversal journal',
      message: `Post a journal on ${toDisplayDate(month.to)} for ${month.label}: ${data.proposal.length} lines, ${formatPaise(data.proposal.filter((l) => l.drCr === 'dr').reduce((t, l) => t + l.amount, 0), { symbol: true })} each side. It saves through the normal voucher save (lock date and audit apply).`,
      confirmLabel: 'Post journal'
    })
    if (!ok) return
    await run(() => api.gst.itcReversalPost(month.from, month.to, month.period), 'ITC reversal journal posted')
  }

  return (
    <Page width="wide">
      <PageHeader
        title="ITC reversal workings"
        tabs={<GstReturnTabs current="itc-reversal" />}
        controls={<MonthBar months={months} value={monthKey} onChange={setMonthKey} testId="input-itc-reversal-month" />}
        secondary={
          <Button data-testid="btn-itc-reversal-apply" disabled={!data || busy || data.applied} onClick={() => void run(() => api.gst.itcReversalApply(month.from, month.to, month.period), `Applied to GSTR-3B ${month.label}`)}>
            {data?.applied ? 'Applied to GSTR-3B ✓' : 'Apply to GSTR-3B'}
          </Button>
        }
        actions={
          data?.posted ? (
            <span className="text-body-sm text-muted" data-testid="itc-reversal-posted">
              Posted · <VoucherLink voucherId={data.posted.voucherId} label={data.posted.number} />
            </span>
          ) : (
            <Button variant="primary" data-testid="btn-itc-reversal-post" disabled={!data || busy || data.proposal.length === 0} onClick={() => void post()}>
              Post journal
            </Button>
          )
        }
        options={{
          content: (
            <>
              <DrawerSection title="How it works">
                <p className="text-hint text-muted">
                  Rule 42 apportions common credit on inputs and input services by exempt ÷ total turnover of the month (borrowing the last
                  month with turnover when there is none), with a 5% non-business share when you say so; the annual true-up uses the
                  year&apos;s turnover and is due by the September return after the year. Rule 43 takes 1/60 of the credit on common capital goods
                  in their 60-month life × the same ratio. Rule 37 reverses the credit on the part of a bill still unpaid 180 days after it, in
                  the return for the period after the 180 days, and re-avails it when paid. Rule 37A (supplier didn&apos;t file) needs the
                  portal — enter it in 3B 4(B)(2) by hand.
                </p>
                <p className="text-hint text-muted">{RULE37_INTEREST_NOTE} Rate {RULE37_RULES.interestPctPa}% p.a.</p>
              </DrawerSection>
              <SourcesSection ids={[...RULE42_RULES.sources, ...RULE37_RULES.sources, 's17', 'rule37A']} />
            </>
          )
        }}
      />

      <UnverifiedBanner ids={['s50-rate', '3b-labels']} testId="itc-reversal-unverified" />

      {isLoading || !data || !s || !inputs ? (
        <Panel>
          <SkeletonRows />
        </Panel>
      ) : (
        <>
          <Panel className="mb-section">
            <div className="p-panel">
              <StatGrid>
                <StatTile label="4(B)(1) rules 42/43" value={<Money paise={sumHeads(s.table4B1)} />} tone="cr" hint={`+ s.17(5) ${formatPaise(sumHeads(s.blocked175), { symbol: true })} (automatic)`} testId="itc-rev-4b1" />
                <StatTile label="4(B)(2) rule 37" value={<Money paise={sumHeads(s.table4B2)} />} tone="cr" testId="itc-rev-4b2" />
                <StatTile label="4(D)(1) re-availed" value={<Money paise={sumHeads(s.reclaimed)} />} tone="dr" testId="itc-rev-4d1" />
                <StatTile label="5.1 interest" value={<Money paise={sumHeads(s.interest)} />} tone="amber" testId="itc-rev-interest" />
              </StatGrid>
            </div>
          </Panel>

          <Panel className="mb-section">
            <p className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">Proposed journal</p>
            <DataTable
              viewId="itc-reversal-proposal"
              testId="itc-reversal-proposal"
              ariaLabel="Proposed ITC reversal journal"
              columns={PROPOSAL_COLUMNS}
              rows={data.proposal}
              rowKey={(l, i) => `${l.role}-${l.head ?? ''}-${i}`}
              maxHeight="none"
              totalsLabel="Total"
              empty={{ title: 'Nothing to reverse or re-avail this month' }}
              exportOptions={{ title: 'ITC reversal journal proposal', periodLabel: month.label, filename: `itc-reversal-journal-${month.period}` }}
            />
            {data.missingTaxLedgers.length > 0 && (
              <p className="px-3 py-2 text-hint text-warning">No input tax ledger for {data.missingTaxLedgers.join(', ')} — one will be created on post.</p>
            )}
          </Panel>

          <Panel className="mb-section">
            <div className="px-3 py-2">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-body-sm font-medium text-ink">Rule 42 — inputs and input services</p>
                <span className="text-small text-muted" data-testid="itc-rev-ratio">
                  E {formatPaise(data.turnover.E, { symbol: true })} ÷ F {formatPaise(data.turnover.F, { symbol: true })}
                  {data.turnover.F > 0 ? ` = ${((data.turnover.E * 100) / data.turnover.F).toFixed(2)}%` : ' (no turnover)'}
                  {data.turnover.borrowed && ' · borrowed from the last month with turnover'}
                </span>
              </div>
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>Figure</th>
                    {HEAD_COLUMNS.map((h) => <th key={h.key} className="r w-32">{h.label}</th>)}
                  </tr>
                </thead>
                <tbody data-testid="rows-itc-reversal-rule42">
                  <HeadsRow label="T — input tax on inputs and input services" value={data.rule42.T} />
                  <HeadsInput label="T1 — exclusively non-business" value={inputs.T1} onChange={(v) => setDraft({ ...inputs, T1: v })} testId="input-itc-rev-t1" />
                  <HeadsInput label="T2 — exclusively exempt supplies" value={inputs.T2} onChange={(v) => setDraft({ ...inputs, T2: v })} testId="input-itc-rev-t2" />
                  <HeadsRow label="T3 — blocked under s.17(5)" value={data.rule42.T3} />
                  <HeadsInput label="T4 — exclusively taxable supplies" value={inputs.T4} onChange={(v) => setDraft({ ...inputs, T4: v })} testId="input-itc-rev-t4" />
                  <HeadsRow label="C2 — common credit" value={data.rule42.C2} strong />
                  <HeadsRow label="D1 — attributable to exempt supplies (E/F × C2)" value={data.rule42.D1} />
                  <HeadsRow label={`D2 — non-business (${RULE42_RULES.nonBusinessPct}% of C2)`} value={data.rule42.D2} />
                  <HeadsRow label="C3 — eligible common credit" value={data.rule42.C3} strong />
                </tbody>
              </table>
              <div className="mt-2 flex flex-wrap items-center gap-4">
                <Checkbox label="Inputs partly used for non-business purposes (D2)" checked={inputs.nonBusiness} onChange={(v) => setDraft({ ...inputs, nonBusiness: v })} testId="chk-itc-rev-nonbusiness" />
                <Checkbox label="Expense the blocked credit booked in input ledgers" checked={inputs.expenseBlocked} onChange={(v) => setDraft({ ...inputs, expenseBlocked: v })} testId="chk-itc-rev-blocked" />
                <Checkbox label="Include the rule 42 annual true-up" checked={inputs.includeTrueUp} onChange={(v) => setDraft({ ...inputs, includeTrueUp: v })} testId="chk-itc-rev-trueup" />
                <span className="flex-1" />
                {dirty && <span className="text-hint text-amber">Unsaved changes</span>}
                <Button size="sm" variant="primary" data-testid="btn-itc-reversal-save-inputs" disabled={!dirty || busy} onClick={() => void run(async () => { await api.gst.setItcReversalInputs(month.period, draft!); setDraft(null) }, 'Inputs saved — workings recomputed')}>
                  Save inputs
                </Button>
              </div>
            </div>
          </Panel>

          <Panel className="mb-section">
            <div className="px-3 py-2">
              <p className="mb-2 text-body-sm font-medium text-ink">Rule 42(2) — annual true-up, FY {fyOf(month.from).label}</p>
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>Figure</th>
                    {HEAD_COLUMNS.map((h) => <th key={h.key} className="r w-32">{h.label}</th>)}
                  </tr>
                </thead>
                <tbody data-testid="rows-itc-reversal-trueup">
                  <HeadsRow label="Σ C2 of the year" value={data.trueUp.C2} />
                  <HeadsRow label="D1 + D2 on the year’s E/F" value={data.trueUp.annual} />
                  <HeadsRow label="Σ monthly D1 + D2" value={data.trueUp.monthly} />
                  <HeadsRow label="Difference (+ reverse with interest from 1 April; − claim back)" value={data.trueUp.difference} strong />
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel className="mb-section">
            <p className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">
              Rule 43 — capital goods (Tc {formatPaise(sumHeads(data.rule43.Tc), { symbol: true })} · Tm {formatPaise(sumHeads(data.rule43.Tm), { symbol: true })} · Te {formatPaise(sumHeads(data.rule43.Te), { symbol: true })})
            </p>
            <DataTable
              viewId="itc-reversal-rule43" testId="itc-reversal-rule43" ariaLabel="Rule 43 capital goods" columns={R43_COLUMNS}
              rows={data.rule43.goods.filter((g) => g.inLife)} rowKey={(g) => g.voucherId} rowAttrs={(g) => ({ 'data-row-id': g.voucherId })}
              onRowActivate={(g) => openVoucher(g.voucherId)} maxHeight="none" empty={{ title: 'No capital goods within their 60-month life' }}
              leadingWidth={44}
              leading={(g) => (
                <input
                  type="checkbox"
                  aria-label={`${g.number} used for both taxable and exempt supplies`}
                  title="Common use (uncheck when used only for taxable supplies)"
                  checked={!inputs.exclusiveCapitalGoods.includes(g.voucherId)}
                  onChange={(e) =>
                    setDraft({
                      ...inputs,
                      exclusiveCapitalGoods: e.target.checked ? inputs.exclusiveCapitalGoods.filter((id) => id !== g.voucherId) : [...inputs.exclusiveCapitalGoods, g.voucherId]
                    })
                  }
                />
              )}
              exportOptions={{ title: 'Rule 43 capital goods', periodLabel: month.label, filename: `itc-rule43-${month.period}` }}
            />
          </Panel>

          <Panel className="mb-section">
            <p className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">Rule 37 — bills unpaid {RULE37_RULES.days} days after the invoice</p>
            <DataTable
              viewId="itc-reversal-rule37" testId="itc-reversal-rule37" ariaLabel="Rule 37 reversals and re-availments" columns={R37_COLUMNS}
              rows={data.rule37} rowKey={(e) => e.bill.voucherId} rowAttrs={(e) => ({ 'data-row-id': e.bill.voucherId })}
              onRowActivate={(e) => openVoucher(e.bill.voucherId)} maxHeight="none" empty={{ title: 'No bill crosses 180 days unpaid, and none was paid after a reversal, this month' }}
              exportOptions={{ title: 'Rule 37 reversals', periodLabel: month.label, filename: `itc-rule37-${month.period}` }}
            />
          </Panel>

          <Panel className="mb-section">
            <p className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">Section 17(5) — blocked credit (parties marked blocked)</p>
            <DataTable
              viewId="itc-reversal-blocked" testId="itc-reversal-blocked" ariaLabel="Blocked credit" columns={BLOCKED_COLUMNS}
              rows={data.blocked} rowKey={(b) => b.voucherId} rowAttrs={(b) => ({ 'data-row-id': b.voucherId })}
              onRowActivate={(b) => openVoucher(b.voucherId)} maxHeight="none" empty={{ title: 'No blocked credit this month' }}
              exportOptions={{ title: 'Blocked credit', periodLabel: month.label, filename: `itc-blocked-${month.period}` }}
            />
          </Panel>
          {data.applied ? null : (
            <Banner tone="info" testId="itc-reversal-not-applied">
              GSTR-3B {month.label} doesn&apos;t carry these figures yet — <b>Apply to GSTR-3B</b> writes 4(B)(1), 4(B)(2), 4(D)(1) and 5.1 interest (the late fee is kept).
            </Banner>
          )}
        </>
      )}
    </Page>
  )
}

