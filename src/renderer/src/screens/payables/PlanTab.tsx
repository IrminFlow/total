// Payables → Plan (WP 4.3): every open supplier bill by its pay-by date (credit terms, or the MSMED
// Act s.15 deadline for micro / small suppliers, whichever is earlier), bucketed overdue / this
// week / next week / later, with early-payment discounts, the indicative s.16 interest and the cash
// available. Plan mode: tick bills → see the total → pick the bank and date → Create payments
// (one payment voucher per supplier, bill-wise, TDS on payment where due).
import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { groupPicksBySupplier, PLAN_BUCKET_LABELS, PLAN_BUCKETS, type PlanBucket } from '@shared/payables/planning'
import type { PayablePlanRow } from '@shared/payables/types'
import { Button, DateInput, DrawerSection, Field, Page, PageHeader, Panel, Segmented, Select, StatGrid, StatTile } from '../../components/ui'
import { OptionToggle, OptionsTable, useScreenOptions } from '../../components/ScreenOptions'
import { DataTable, defineColumns } from '../../components/table'
import { LedgerLink, VoucherLink } from '../../components/links'
import { payablesApi } from '../../lib/payablesClient'
import { useCanEditMasters } from '../../lib/drill'
import { MsmeBadge, pct, usePayablesAsOn } from './common'
import { RunPreviewModal } from './RunModals'

const BASIS_LABEL = { agreed: 'agreed', agreed_capped: 'agreed, capped at 45 d', no_agreement: 'no agreement: 15 d' } as const

export const PLAN_COLUMNS = defineColumns<PayablePlanRow>([
  {
    id: 'party', header: 'Supplier', kind: 'text', value: (r) => r.partyName, minWidth: 140, hideable: false,
    cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.partyName} />
  },
  {
    id: 'bill', header: 'Bill', kind: 'text', value: (r) => r.number, width: 96,
    cell: (r) => <VoucherLink voucherId={r.voucherId} label={<span className="num">{r.number}</span>} />
  },
  { id: 'ref', header: 'Supplier inv.', kind: 'text', value: (r) => r.supplierRef ?? '', width: 110, defaultHidden: true },
  { id: 'date', header: 'Bill date', kind: 'date', value: (r) => r.date, width: 104, className: 'text-muted' },
  { id: 'due', header: 'Due (terms)', kind: 'date', value: (r) => r.dueDate ?? '', defaultHidden: true },
  {
    id: 'msme', header: 'MSME', kind: 'enum', value: (r) => r.msme?.category ?? '', width: 70,
    options: [{ value: 'micro', label: 'Micro' }, { value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }],
    cell: (r) => <MsmeBadge msme={r.msme} />
  },
  {
    id: 's15', header: 's.15 pay by', kind: 'date', value: (r) => r.s15?.payBy ?? '', width: 100,
    text: (r) => (r.s15 ? `${toDisplayDate(r.s15.payBy)} (${BASIS_LABEL[r.s15.basis]})` : ''),
    cell: (r) => (r.s15 ? <span className="num" title={BASIS_LABEL[r.s15.basis]}>{toDisplayDate(r.s15.payBy)}</span> : null)
  },
  { id: 'payBy', header: 'Pay by', kind: 'date', value: (r) => r.payBy, width: 100, className: 'font-medium' },
  {
    id: 'bucket', header: 'When', kind: 'enum', value: (r) => r.bucket, width: 96, groupKey: (r) => PLAN_BUCKET_LABELS[r.bucket],
    options: PLAN_BUCKETS.map((b) => ({ value: b, label: PLAN_BUCKET_LABELS[b] })), text: (r) => PLAN_BUCKET_LABELS[r.bucket],
    cell: (r) => <span className={r.bucket === 'overdue' ? 'text-cr' : r.bucket === 'this_week' ? 'text-amber' : ''}>{PLAN_BUCKET_LABELS[r.bucket]}</span>
  },
  {
    id: 'days', header: 'Days', kind: 'number', value: (r) => r.daysToPay, width: 92,
    text: (r) => (r.daysToPay < 0 ? `${-r.daysToPay} late` : `in ${r.daysToPay}`)
  },
  { id: 'amount', header: 'Bill amount', kind: 'money', value: (r) => r.amount, width: 130, defaultHidden: true },
  { id: 'pending', header: 'Pending', kind: 'money', value: (r) => r.pending, width: 120, aggregate: 'sum', className: 'font-medium' },
  {
    id: 'discount', header: 'Discount', kind: 'money', value: (r) => (r.discount?.available ? r.discount.paise : null), width: 96,
    aggregate: (rows) => rows.reduce((s, r) => s + (r.discount?.available ? r.discount.paise : 0), 0),
    text: (r) => (r.discount ? `${formatPaise(r.discount.paise)} (${pct(r.discount.bp)} by ${toDisplayDate(r.discount.by)})` : ''),
    cell: (r) =>
      r.discount ? (
        <span className={r.discount.available ? 'text-dr' : 'text-muted line-through'} title={`${pct(r.discount.bp)} if paid by ${toDisplayDate(r.discount.by)}`}>
          {formatPaise(r.discount.paise)}
        </span>
      ) : null
  },
  {
    id: 'interest', header: 'Interest', kind: 'money', value: (r) => (r.interestIndicative > 0 ? r.interestIndicative : null), width: 100,
    aggregate: 'sum', className: 'text-cr'
  }
])

type Filter = 'all' | PlanBucket | 'msme'

export function PlanTab({ tabs }: { tabs: ReactNode }): React.JSX.Element {
  const defaultAsOn = usePayablesAsOn()
  const [asOn, setAsOn] = useState(defaultAsOn)
  const canWrite = useCanEditMasters()
  const opts = useScreenOptions('payables-plan', { msmeFirst: false, hideMedium: false })
  const [filter, setFilter] = useState<Filter>('all')
  const [planMode, setPlanMode] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [bankId, setBankId] = useState<number | ''>('')
  const [payDate, setPayDate] = useState(defaultAsOn)
  const [preview, setPreview] = useState(false)

  const { data, isLoading } = useQuery({ queryKey: ['payablesPlan', asOn], queryFn: () => payablesApi.plan(asOn) })
  const allRows = useMemo(() => data?.rows ?? [], [data])
  const rows = useMemo(() => {
    let r = allRows.filter((x) => filter === 'all' || (filter === 'msme' ? !!x.s15 : x.bucket === filter))
    if (opts.options.hideMedium) r = r.filter((x) => x.msme?.category !== 'medium')
    if (opts.options.msmeFirst) r = [...r].sort((a, b) => Number(!!b.s15) - Number(!!a.s15))
    return r
  }, [allRows, filter, opts.options.hideMedium, opts.options.msmeFirst])

  const banks = data?.cash.ledgers ?? []
  const selected = allRows.filter((r) => picked.has(r.key))
  const selectedTotal = selected.reduce((s, r) => s + r.pending, 0)
  const bank = banks.find((b) => b.ledgerId === bankId) ?? null
  const items = useMemo(
    () =>
      bankId === ''
        ? []
        : groupPicksBySupplier(selected.map((r) => ({ ledgerId: r.ledgerId, number: r.number, amount: r.pending }))).map((s) => ({
            partyLedgerId: s.partyLedgerId, bankLedgerId: bankId, amount: s.amount, bills: s.bills
          })),
    [selected, bankId]
  )

  const toggle = (key: string): void =>
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  const pickVisible = (on: boolean): void =>
    setPicked((s) => {
      const n = new Set(s)
      for (const r of rows) {
        if (on) n.add(r.key)
        else n.delete(r.key)
      }
      return n
    })

  const t = data?.totals
  const periodLabel = `as on ${toDisplayDate(asOn)}`
  return (
    <Page width="wide">
      <PageHeader
        title="Payables"
        period={periodLabel}
        tabs={tabs}
        controls={
          <DateInput value={asOn} context={asOn} onChange={setAsOn} testId="input-payables-as-on" ariaLabel="Plan as on" className="w-32" />
        }
        secondary={
          canWrite && (
            <Button
              data-testid="btn-payables-plan-mode"
              variant={planMode ? 'primary' : 'secondary'}
              onClick={() => {
                setPlanMode((m) => !m)
                setPicked(new Set())
              }}
            >
              {planMode ? 'Done planning' : 'Plan payments'}
            </Button>
          )
        }
        options={{
          onReset: opts.reset,
          content: (
            <>
              <DrawerSection title="Display">
                <OptionToggle label="MSME (micro / small) bills first" checked={opts.options.msmeFirst} onChange={(v) => opts.set('msmeFirst', v)} testId="input-payables-msme-first" />
                <OptionToggle label="Hide medium enterprises" checked={opts.options.hideMedium} onChange={(v) => opts.set('hideMedium', v)} testId="input-payables-hide-medium" />
              </DrawerSection>
              <OptionsTable area="payables-plan" />
              <DrawerSection title="How the dates work">
                <p className="text-hint text-muted">
                  Pay by is the earlier of the bill&apos;s due date (bill-wise due date, else bill date + the supplier&apos;s credit days) and, for a
                  micro or small supplier registered on Udyam, the MSMED Act 2006 s.15 deadline: the period agreed in writing (at most 45 days
                  from acceptance) or 15 days when there is no written agreement. Acceptance is taken as the bill date. Interest under s.16 is
                  compound with monthly rests at three times the RBI bank rate — shown as indicative. Medium enterprises are not s.2(n)
                  suppliers, so no s.15 deadline applies to them. Early-payment discounts come from the supplier&apos;s ledger terms; nothing is
                  posted for them — take a discount with a debit note.
                </p>
              </DrawerSection>
            </>
          )
        }}
      />
      <StatGrid className="mb-section">
        <StatTile label="Overdue" value={formatPaise(t?.overdue ?? 0, { symbol: true })} tone="cr" testId="payables-tile-overdue" loading={isLoading} onClick={() => setFilter('overdue')} />
        <StatTile label="Due this week" value={formatPaise(t?.this_week ?? 0, { symbol: true })} tone="amber" testId="payables-tile-this-week" loading={isLoading} onClick={() => setFilter('this_week')} />
        <StatTile label="Due next week" value={formatPaise(t?.next_week ?? 0, { symbol: true })} testId="payables-tile-next-week" loading={isLoading} onClick={() => setFilter('next_week')} />
        <StatTile label="Later" value={formatPaise(t?.later ?? 0, { symbol: true })} testId="payables-tile-later" loading={isLoading} onClick={() => setFilter('later')} />
        <StatTile
          label="MSME past s.15"
          value={formatPaise(t?.msmeOverdue ?? 0, { symbol: true })}
          tone={(t?.msmeOverdue ?? 0) > 0 ? 'cr' : undefined}
          hint="Micro / small dues past the 45-day / 15-day period"
          testId="payables-tile-msme"
          loading={isLoading}
          onClick={() => setFilter('msme')}
        />
        <StatTile
          label="Cash & bank"
          value={formatPaise(data?.cash.total ?? 0, { symbol: true })}
          tone="dr"
          hint={banks.slice(0, 3).map((b) => `${b.name} ${formatPaise(b.balance)}`).join(' · ')}
          testId="payables-tile-cash"
          loading={isLoading}
        />
      </StatGrid>

      {planMode && (
        <Panel className="mb-section" testId="payables-plan-bar">
          <div className="flex flex-wrap items-end gap-3 px-4 py-3">
            <div className="min-w-[180px]">
              <p className="text-caption text-muted">Selected</p>
              <p className="num text-body font-semibold" data-testid="payables-selected-total">
                {formatPaise(selectedTotal, { symbol: true })} <span className="text-hint font-normal text-muted">· {selected.length} bill{selected.length === 1 ? '' : 's'}</span>
              </p>
            </div>
            <Field label="Pay from">
              <Select data-testid="input-payables-bank" value={bankId} onChange={(e) => setBankId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Choose bank / cash…</option>
                {banks.map((b) => (
                  <option key={b.ledgerId} value={b.ledgerId}>
                    {b.name} — {formatPaise(b.balance)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Payment date">
              <DateInput value={payDate} context={payDate} onChange={setPayDate} testId="input-payables-pay-date" className="w-32" />
            </Field>
            {bank && (
              <p className={`pb-2 text-hint ${bank.balance < selectedTotal ? 'text-cr' : 'text-muted'}`} data-testid="payables-bank-after">
                After: {formatPaise(bank.balance - selectedTotal, { symbol: true })} (before TDS)
              </p>
            )}
            <div className="ml-auto flex gap-2 pb-0.5">
              <Button size="sm" variant="ghost" data-testid="btn-payables-pick-visible" onClick={() => pickVisible(true)}>
                Tick all shown
              </Button>
              <Button size="sm" variant="ghost" data-testid="btn-payables-clear" onClick={() => setPicked(new Set())}>
                Clear
              </Button>
              <Button variant="primary" data-testid="btn-payables-create" disabled={items.length === 0} onClick={() => setPreview(true)}>
                Create payments…
              </Button>
            </div>
          </div>
        </Panel>
      )}

      <Panel>
        <DataTable
          viewId="payables-plan"
          testId="payables-plan"
          ariaLabel="Supplier bills by pay-by date"
          columns={PLAN_COLUMNS}
          rows={rows}
          rowKey={(r) => r.key}
          rowAttrs={(r) => ({ 'data-row-id': r.voucherId ?? undefined, 'data-bucket': r.bucket, 'data-key': r.key })}
          loading={isLoading}
          leading={
            planMode
              ? (r) => (
                  <input
                    type="checkbox"
                    aria-label={`Pay ${r.partyName} ${r.number}`}
                    data-testid={`pick-payables-${r.ledgerId}-${r.number}`}
                    checked={picked.has(r.key)}
                    onChange={() => toggle(r.key)}
                  />
                )
              : undefined
          }
          leadingWidth={44}
          onRowActivate={planMode ? (r) => toggle(r.key) : undefined}
          toolbarStart={
            <Segmented<Filter>
              label="Show"
              size="sm"
              testId="payables-filter"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'overdue', label: 'Overdue' },
                { value: 'this_week', label: 'This week' },
                { value: 'next_week', label: 'Next week' },
                { value: 'later', label: 'Later' },
                { value: 'msme', label: 'MSME' }
              ]}
            />
          }
          empty={{ title: filter === 'all' ? `Nothing to pay as on ${toDisplayDate(asOn)}` : 'No bills in this bucket' }}
          exportOptions={{ title: 'Payables plan', periodLabel, filename: 'payables-plan' }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">
        Total pending equals Payables in Outstandings · {planMode ? 'tick bills, pick the bank, then Create payments' : 'Plan payments to tick bills and pay them'} · F12 for options.
      </p>
      {preview && bankId !== '' && (
        <RunPreviewModal
          input={{ date: payDate, kind: 'plan', applyTds: true, items }}
          onClose={() => setPreview(false)}
          onPosted={() => {
            setPicked(new Set())
            setPlanMode(false)
          }}
        />
      )}
    </Page>
  )
}
