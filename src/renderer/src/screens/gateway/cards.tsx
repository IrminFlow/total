// Gateway dashboard cards (WP 1.10b). Each card takes its own CardState, so a section that
// failed (or threw while rendering — CardBoundary) degrades alone.
import { useEffect, useMemo, useState } from 'react'
import type {
  DashAgeing, DashCash, DashGst, DashParty, DashStatus, DashStock, DashTds, DashTrade, DashActivity, DashboardWindow, DashSetup, DashPdc
} from '@shared/dashboard'
import type { DayBookRow } from '@shared/reports'
import { formatPaise, formatPaiseCompact } from '@shared/money'
import { toDisplayDate, toDisplayDateTime, toMonthLabel, todayISO } from '@shared/dates'
import { upcomingDeadlines } from '@shared/compliance'
import { api } from '../../lib/client'
import { useNav, useSession } from '../../state/stores'
import { Badge, Checklist, Money } from '../../components/ui'
import { ItemLink, LedgerLink, drillRowProps } from '../../components/links'
import { openLedgerStatement } from '../../lib/drill'
import { BarChart, ChartLegend, LineChart, type ChartCategory } from '../../components/charts'
import { formatMilli } from '../../lib/table'
import { CardLink, DashCard, type CardState } from './parts'
import { onboardingFromDashSetup } from '@shared/onboarding'
import { onboardingScreen } from '../../lib/onboarding'
import { PromisedChip } from './PromisedChip'

const stackRowCls =
  'flex w-full cursor-pointer flex-col gap-1 border-b border-line/40 px-4 py-2 text-left hover:bg-panel2 focus-visible:bg-panel2 focus-visible:outline-none'
const rowCls =
  'flex w-full cursor-pointer items-center gap-3 border-b border-line/40 px-4 py-[5px] text-left last:border-b-0 hover:bg-panel2 focus-visible:bg-panel2 focus-visible:outline-none'

export function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000)
}

/** "in 5 days" / "tomorrow" / "today". */
export function dueIn(date: string, today: string): string {
  const d = daysUntil(date, today)
  return d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`
}

const dueTone = (date: string, today: string): 'amber' | 'neutral' => (daysUntil(date, today) <= 5 ? 'amber' : 'neutral')

function monthCategories(w: DashboardWindow): ChartCategory[] {
  return w.periodMonths.map((m) => ({ key: m, label: toMonthLabel(m), long: toMonthLabel(m, 'long') }))
}

// ---------- charts ----------

export function TradeChartCard({ card, window: w }: { card: CardState<DashTrade>; window: DashboardWindow | undefined }): React.JSX.Element {
  const nav = useNav()
  return (
    <DashCard
      title="Sales vs purchases"
      testId="dash-trade"
      card={card}
      skeletonRows={6}
      action={<CardLink onClick={() => nav.go({ name: 'registers' })}>Registers →</CardLink>}
    >
      {(t) => {
        const cats = monthCategories(w!)
        const byMonth = new Map(t.months.map((m) => [m.month, m]))
        const sales = cats.map((c) => byMonth.get(c.key)?.sales ?? null)
        const purchases = cats.map((c) => byMonth.get(c.key)?.purchases ?? null)
        const summary =
          `Monthly sales and purchases, taxable value net of notes, ${cats[0]?.long} to ${cats.at(-1)?.long}. ` +
          `Period sales ${formatPaise(t.periodSales, { symbol: true })}, purchases ${formatPaise(t.periodPurchases, { symbol: true })}.`
        return (
          <div className="px-3 pt-2 pb-1">
            <div className="flex items-baseline justify-between px-1 pb-1">
              <ChartLegend series={[{ id: 's', label: 'Sales', color: 'blue' }, { id: 'p', label: 'Purchases', color: 'amber' }]} />
              <p className="num text-caption text-muted">
                <span className="text-blue">{formatPaiseCompact(t.periodSales)}</span> · <span className="text-amber">{formatPaiseCompact(t.periodPurchases)}</span>
              </p>
            </div>
            <BarChart
              testId="chart-trade"
              title="Sales vs purchases by month"
              summary={summary}
              categories={cats}
              height={176}
              series={[
                { id: 'sales', label: 'Sales', color: 'blue', values: sales },
                { id: 'purchases', label: 'Purchases', color: 'amber', values: purchases }
              ]}
            />
          </div>
        )
      }}
    </DashCard>
  )
}

export function ProfitChartCard({ card, window: w }: { card: CardState<DashTrade>; window: DashboardWindow | undefined }): React.JSX.Element {
  const nav = useNav()
  return (
    <DashCard
      title="Net profit by month"
      testId="dash-profit"
      card={card}
      skeletonRows={6}
      action={<CardLink onClick={() => nav.go({ name: 'profit-loss' })}>Profit &amp; loss →</CardLink>}
    >
      {(t) => {
        const cats = monthCategories(w!)
        const byMonth = new Map(t.months.map((m) => [m.month, m]))
        const values = cats.map((c) => byMonth.get(c.key)?.netProfit ?? null)
        const tone = t.periodNetProfit < 0 ? 'text-cr' : 'text-dr'
        return (
          <div className="px-3 pt-2 pb-1">
            <div className="flex items-baseline justify-between px-1 pb-1">
              <span className="text-caption text-muted">{t.periodNetProfit < 0 ? 'Loss' : 'Profit'} for the period</span>
              <span className={`num text-small ${tone}`}>{formatPaise(t.periodNetProfit, { symbol: true })}</span>
            </div>
            <LineChart
              testId="chart-profit"
              title="Net profit by month"
              summary={`Monthly net profit (P&L), ${cats[0]?.long} to ${cats.at(-1)?.long}; period total ${formatPaise(t.periodNetProfit, { symbol: true })}.`}
              categories={cats}
              height={176}
              negativeColor="cr"
              series={[{ id: 'profit', label: 'Net profit', color: 'dr', values }]}
            />
          </div>
        )
      }}
    </DashCard>
  )
}

// ---------- parties ----------

const BUCKETS = ['0–30 days', '31–60 days', '61–90 days', '90+ days']

function AgeingBars({ a, color, label }: { a: DashAgeing; color: 'blue' | 'amber'; label: string }): React.JSX.Element {
  const max = Math.max(1, ...a.buckets)
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between">
        <span className="text-small text-ink">{label}</span>
        <Money paise={a.total} className="text-body-sm" />
      </div>
      <table className="mt-1 w-full text-caption">
        <caption className="sr-only">{label} by days overdue</caption>
        <tbody>
          {a.buckets.map((b, i) => (
            <tr key={i}>
              <th scope="row" className="w-[68px] py-[3px] pr-2 text-left font-normal whitespace-nowrap text-muted">
                {BUCKETS[i]}
              </th>
              <td className="py-[3px]">
                <span className="block h-2 rounded-sm bg-panel2">
                  <span
                    className="block h-2 rounded-sm"
                    style={{ width: `${b === 0 ? 0 : Math.max(2, Math.round((b / max) * 100))}%`, background: `var(--t-${color})`, opacity: i >= 2 ? 1 : 0.75 }}
                  />
                </span>
              </td>
              <td className="num w-[56px] py-[3px] pl-2 text-right text-muted">{formatPaiseCompact(b)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function AgeingCard({ receivables, payables }: { receivables: CardState<DashAgeing>; payables: CardState<DashAgeing> }): React.JSX.Element {
  const nav = useNav()
  // Both halves must be ready to draw; either failing shows that half's error inside.
  const combined: CardState<{ r: DashAgeing | string; p: DashAgeing | string }> =
    receivables.state === 'loading' || payables.state === 'loading'
      ? { state: 'loading' }
      : {
          state: 'ready',
          data: {
            r: receivables.state === 'ready' ? receivables.data : receivables.error,
            p: payables.state === 'ready' ? payables.data : payables.error
          }
        }
  return (
    <DashCard
      title="Ageing"
      testId="dash-ageing"
      card={combined}
      action={<CardLink onClick={() => nav.go({ name: 'outstandings' })}>Outstandings →</CardLink>}
    >
      {({ r, p }) => (
        <div className="flex flex-col gap-3 px-4 py-2.5">
          {typeof r === 'string' ? <p className="text-small text-cr">Receivables unavailable</p> : <AgeingBars a={r} color="blue" label="Receivables" />}
          {typeof p === 'string' ? <p className="text-small text-cr">Payables unavailable</p> : <AgeingBars a={p} color="amber" label="Payables" />}
        </div>
      )}
    </DashCard>
  )
}

export function TopPartiesCard({ title, testId, card, empty }: { title: string; testId: string; card: CardState<DashParty[]>; empty: string }): React.JSX.Element {
  return (
    <DashCard title={title} testId={testId} card={card} skeletonRows={5}>
      {(rows) =>
        rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-body-sm text-muted">{empty}</p>
        ) : (
          <div>
            {rows.map((r, i) => (
              // Name → the ledger's edit window; the rest of the row → its statement.
              <div key={r.ledgerId} data-testid="top-ledger" title={`Open ${r.name} statement`} {...drillRowProps(() => openLedgerStatement(r.ledgerId), r.ledgerId)} className={rowCls}>
                <span className="num w-3 text-caption text-muted">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-body-sm">
                  <LedgerLink ledgerId={r.ledgerId} name={r.name} />
                </span>
                <Money paise={r.amount} className="text-body-sm" />
              </div>
            ))}
          </div>
        )
      }
    </DashCard>
  )
}

// ---------- compliance ----------

/** Fires once per company per app session (not per Gateway mount) — module-level, keyed by slug. */
const notifiedCompanies = new Set<string>()

export function ComplianceCard({
  gst,
  tds,
  hasPayroll,
  dashboardLoaded,
  pdc = null
}: {
  gst: CardState<DashGst | null>
  tds: CardState<DashTds | null> | null
  /** WP 4.1 — post-dated cheques maturing this week (null = none / not loaded). */
  pdc?: DashPdc | null
  /** Payroll feature on AND active employees — PF/ESI deadlines show only then. */
  hasPayroll: boolean
  dashboardLoaded: boolean
}): React.JSX.Element {
  const nav = useNav()
  const { info, slug } = useSession()
  const today = todayISO()
  const [showAll, setShowAll] = useState(false)
  const regType = info?.gstRegistrationType ?? 'unregistered'
  const deadlines = useMemo(() => upcomingDeadlines(today, regType, hasPayroll, 30), [today, regType, hasPayroll])
  // GST and TDS have their own rows; the list carries the rest (PF/ESI/advance tax).
  const others = deadlines.filter((d) => d.kind !== 'gst' && !(d.kind === 'tds' && tds))

  useEffect(() => {
    if (!info || !slug || !dashboardLoaded || notifiedCompanies.has(slug)) return
    notifiedCompanies.add(slug)
    const soon = upcomingDeadlines(today, regType, hasPayroll, 3)
    if (soon.length) {
      // Fire-and-forget: an OS notification failing is not worth interrupting the Gateway for.
      void api.app.notifyDeadlines(soon.map((d) => ({ title: d.form, body: `${d.title} — due ${toDisplayDate(d.date)}` }))).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, slug, hasPayroll, dashboardLoaded])

  const combined: CardState<{ gst: DashGst | null | string; tds: DashTds | null | string }> =
    gst.state === 'loading' || tds?.state === 'loading'
      ? { state: 'loading' }
      : {
          state: 'ready',
          data: {
            gst: gst.state === 'ready' ? gst.data : gst.error,
            tds: tds == null ? null : tds.state === 'ready' ? tds.data : tds.error
          }
        }

  return (
    <DashCard title="Compliance" testId="dash-compliance" card={combined} skeletonRows={5}>
      {({ gst: g, tds: t }) => (
        <div className="flex flex-col">
          {typeof g === 'string' ? (
            <p className="px-4 py-2 text-small text-cr">GST unavailable</p>
          ) : (
            g && (
              <div data-testid="dash-gst" {...drillRowProps(() => nav.go({ name: 'gstr3b' }))} className={stackRowCls}>
                <span className="text-body-sm text-ink">GST returns · {toMonthLabel(g.period, 'long')}</span>
                <span className="flex flex-wrap gap-1">
                  {g.gstr1Due && <Badge tone={dueTone(g.gstr1Due, today)} testId="chip-gstr1">GSTR-1 {dueIn(g.gstr1Due, today)}</Badge>}
                  {g.gstr3bDue && <Badge tone={dueTone(g.gstr3bDue, today)} testId="chip-gstr3b">GSTR-3B {dueIn(g.gstr3bDue, today)}</Badge>}
                </span>
                <dl className="grid grid-cols-3 gap-2 text-caption">
                  <div><dt className="text-muted">Output tax</dt><dd className="num text-ink">{formatPaiseCompact(g.liability)}</dd></div>
                  <div><dt className="text-muted">ITC</dt><dd className="num text-ink">{formatPaiseCompact(g.itc)}</dd></div>
                  <div><dt className="text-muted">Cash payable</dt><dd className={`num ${g.payable > 0 ? 'text-cr' : 'text-ink'}`} title={formatPaise(g.payable, { symbol: true })}>{formatPaiseCompact(g.payable)}</dd></div>
                </dl>
              </div>
            )
          )}
          {typeof t === 'string' ? (
            <p className="px-4 py-2 text-small text-cr">TDS unavailable</p>
          ) : (
            t && (
              <div data-testid="dash-tds" {...drillRowProps(() => nav.go({ name: 'tds' }))} className={stackRowCls}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-body-sm text-ink">TDS · {t.quarter}</span>
                  {t.nextDue && <Badge tone={dueTone(t.nextDue, today)} testId="chip-tds">Challan {dueIn(t.nextDue, today)}</Badge>}
                </div>
                <dl className="grid grid-cols-3 gap-2 text-caption">
                  <div><dt className="text-muted">This quarter</dt><dd className="num text-ink">{formatPaiseCompact(t.deducted)}</dd></div>
                  <div className="col-span-2"><dt className="text-muted">Not yet deposited</dt><dd className={`num ${t.payable > 0 ? 'text-cr' : 'text-ink'}`}>{formatPaise(t.payable, { symbol: true })}</dd></div>
                </dl>
              </div>
            )
          )}
          <PromisedChip />
          {typeof g !== 'string' && g?.annual && g.annual.length > 0 && (
            <div data-testid="dash-gst-annual" {...drillRowProps(() => nav.go({ name: 'gstr9' }))} className={stackRowCls}>
              <span className="text-body-sm text-ink">Annual GST</span>
              <span className="flex flex-wrap gap-1">
                {g.annual.map((d) => (
                  <Badge key={`${d.form}-${d.date}`} tone={dueTone(d.date, today)} testId={`chip-${d.form.toLowerCase()}`}>
                    <span title={d.title}>{d.form} {dueIn(d.date, today)}</span>
                  </Badge>
                ))}
              </span>
            </div>
          )}
          {pdc && pdc.received.count + pdc.issued.count > 0 && (
            <div data-testid="dash-pdc" {...drillRowProps(() => nav.go({ name: 'banking', tab: 'pdc' }))} className={stackRowCls}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-body-sm text-ink">Post-dated cheques · this week</span>
                {pdc.overdue > 0 && <Badge tone="danger" testId="chip-pdc-overdue">{pdc.overdue} past due</Badge>}
              </div>
              <dl className="grid grid-cols-2 gap-2 text-caption">
                <div>
                  <dt className="text-muted">Received · {pdc.received.count}</dt>
                  <dd className="num text-ink" title={formatPaise(pdc.received.amount, { symbol: true })}>{formatPaiseCompact(pdc.received.amount)}</dd>
                </div>
                <div>
                  <dt className="text-muted">Issued · {pdc.issued.count}</dt>
                  <dd className="num text-ink" title={formatPaise(pdc.issued.amount, { symbol: true })}>{formatPaiseCompact(pdc.issued.amount)}</dd>
                </div>
              </dl>
            </div>
          )}
          {(showAll ? others : others.slice(0, 3)).map((d) => (
            <div key={d.id} className="flex items-center gap-2 border-b border-line/40 px-4 py-[5px] last:border-b-0">
              <span className="num w-[62px] text-caption text-muted">{toDisplayDate(d.date)}</span>
              <span className="min-w-0 flex-1 truncate text-small" title={d.title}>{d.title}</span>
            </div>
          ))}
          {others.length > 3 && (
            <button data-testid="btn-gateway-compliance-all" className="px-4 py-1.5 text-left text-hint text-blue hover:underline" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer' : `Show all ${others.length}`}
            </button>
          )}
          {g === null && !t && others.length === 0 && !(pdc && pdc.received.count + pdc.issued.count > 0) && <p className="px-4 py-6 text-center text-body-sm text-muted">Nothing due in the next 30 days</p>}
        </div>
      )}
    </DashCard>
  )
}

// ---------- balances, stock, books ----------

export function CashCard({ card }: { card: CardState<DashCash> }): React.JSX.Element {
  const nav = useNav()
  return (
    <DashCard title="Cash & bank" testId="dash-cash" card={card} action={<CardLink onClick={() => nav.go({ name: 'banking' })}>Banking →</CardLink>}>
      {(c) => (
        <div>
          {c.ledgers.map((l) => (
            <div key={l.ledgerId} data-testid="cash-ledger" {...drillRowProps(() => openLedgerStatement(l.ledgerId), l.ledgerId)} className={rowCls}>
              <span className="w-9 text-label text-muted uppercase">{l.kind}</span>
              <span className="min-w-0 flex-1 truncate text-body-sm">
                <LedgerLink ledgerId={l.ledgerId} name={l.name} />
              </span>
              <Money paise={l.balance} className={`text-body-sm ${l.balance < 0 ? 'text-cr' : ''}`} />
            </div>
          ))}
          <div className="flex items-center justify-between px-4 py-1.5 text-small">
            <span className="text-muted">Total</span>
            <Money paise={c.total} className="text-body-sm font-medium" />
          </div>
        </div>
      )}
    </DashCard>
  )
}

export function StockCard({ card }: { card: CardState<DashStock | null> }): React.JSX.Element {
  const nav = useNav()
  return (
    <DashCard title="Stock alerts" testId="dash-stock" card={card} action={<CardLink onClick={() => nav.go({ name: 'stock-summary' })}>Stock →</CardLink>}>
      {(s) => {
        const rows = [
          ...(s?.negative ?? []).map((r) => ({ ...r, why: 'negative' as const })),
          ...(s?.belowReorder ?? []).filter((r) => !(s?.negative ?? []).some((n) => n.stockItemId === r.stockItemId)).map((r) => ({ ...r, why: 'reorder' as const }))
        ]
        return rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-body-sm text-muted">No negative stock or reorder alerts</p>
        ) : (
          <div>
            {rows.slice(0, 6).map((r) => (
              <div key={`${r.why}-${r.stockItemId}`} data-testid="stock-alert" {...drillRowProps(() => nav.go({ name: 'stock-summary' }))} className={rowCls}>
                <span className="min-w-0 flex-1 truncate text-body-sm">
                  <ItemLink itemId={r.stockItemId} name={r.name} />
                </span>
                <span className={`num text-hint ${r.why === 'negative' ? 'text-cr' : 'text-muted'}`}>
                  {formatMilli(r.closingQtyMilli, r.decimals)} {r.unitSymbol}
                  {r.why === 'reorder' && r.reorderLevelMilli != null && ` / ${formatMilli(r.reorderLevelMilli, r.decimals)}`}
                </span>
                <Badge tone={r.why === 'negative' ? 'danger' : 'amber'}>{r.why === 'negative' ? 'Negative' : 'Reorder'}</Badge>
              </div>
            ))}
            {rows.length > 6 && <p className="px-4 py-1.5 text-caption text-muted">+{rows.length - 6} more in Stock summary</p>}
          </div>
        )
      }}
    </DashCard>
  )
}

export function BooksCard({
  activity,
  status,
  onBackup,
  backingUp
}: {
  activity: CardState<DashActivity>
  status: CardState<DashStatus>
  onBackup: () => void
  backingUp: boolean
}): React.JSX.Element {
  const nav = useNav()
  const combined: CardState<{ a: DashActivity | null; s: DashStatus | null }> =
    activity.state === 'loading' || status.state === 'loading'
      ? { state: 'loading' }
      : { state: 'ready', data: { a: activity.state === 'ready' ? activity.data : null, s: status.state === 'ready' ? status.data : null } }
  return (
    <DashCard title="Books" testId="dash-books" card={combined}>
      {({ a, s }) => (
        <div className="flex flex-col">
          <div {...drillRowProps(() => nav.go({ name: 'daybook' }))} data-testid="dash-daybook" className={rowCls}>
            <span className="flex-1 text-body-sm">Day Book</span>
            <span className="num text-small text-muted">{a ? `${a.today} today · ${a.week} this week` : 'unavailable'}</span>
          </div>
          <div className="flex items-center gap-3 border-b border-line/40 px-4 py-[5px]">
            <span className="flex-1 text-body-sm whitespace-nowrap">Last backup</span>
            <span className="num text-small text-muted" data-testid="dash-last-backup">
              {s?.lastBackup ? toDisplayDateTime(new Date(s.lastBackup.at)) : 'never'}
            </span>
            <button type="button" data-testid="btn-gateway-backup" disabled={backingUp} onClick={onBackup} className="text-hint text-blue hover:underline disabled:opacity-50">
              {backingUp ? 'Backing up…' : 'Back up now'}
            </button>
          </div>
          <div className="flex items-center gap-3 px-4 py-[5px]">
            <span className="flex-1 text-body-sm">Period lock</span>
            {s?.lockDate ? <Badge tone="neutral">Locked to {toDisplayDate(s.lockDate)}</Badge> : <span className="text-small text-muted">Not locked</span>}
          </div>
        </div>
      )}
    </DashCard>
  )
}

export function RecentCard({ rows }: { rows: DayBookRow[] | undefined }): React.JSX.Element {
  const nav = useNav()
  const card: CardState<DayBookRow[]> = rows === undefined ? { state: 'loading' } : { state: 'ready', data: rows }
  return (
    <DashCard title="Recent entries" testId="dash-recent" card={card} skeletonRows={6} action={<CardLink onClick={() => nav.go({ name: 'daybook' })}>Day Book →</CardLink>}>
      {(list) =>
        list.length === 0 ? (
          <p className="px-4 py-6 text-center text-body-sm text-muted">No vouchers in this period yet</p>
        ) : (
          <div>
            {list.map((v) => (
              // The row opens the voucher; the account NAME opens its ledger's edit window.
              <div
                key={v.voucherId}
                data-testid="recent-voucher"
                className={rowCls}
                {...drillRowProps(() => nav.go({ name: 'voucher-entry', voucherId: v.voucherId }), v.accountLedgerId ?? undefined)}
              >
                <span className="num w-[66px] shrink-0 text-hint whitespace-nowrap text-muted">{toDisplayDate(v.date)}</span>
                <span className="w-20 truncate text-small text-muted">{v.voucherType}</span>
                <span className="num w-12 truncate text-hint text-muted">{v.number}</span>
                <span className="min-w-0 flex-1 truncate text-body-sm">
                  <LedgerLink ledgerId={v.accountLedgerId} name={v.account} />
                  {v.isOptional && (
                    <Badge tone="amber" className="ml-2" testId="recent-badge-optional">
                      Optional
                    </Badge>
                  )}
                  {v.postDated && (
                    <Badge tone="info" className="ml-2" testId="recent-badge-pdc">
                      PDC
                    </Badge>
                  )}
                </span>
                <Money paise={v.debit} className="text-body-sm" />
              </div>
            ))}
          </div>
        )
      }
    </DashCard>
  )
}

/** "Set up your books" — the shared checklist (src/shared/onboarding.ts) from the dashboard's setup
 *  section, rendered with the kit Checklist inside a dashboard card. Hidden once complete. */
export function OnboardingCard({ setup }: { setup: DashSetup }): React.JSX.Element | null {
  const nav = useNav()
  const checklist = onboardingFromDashSetup(setup)
  if (checklist.complete) return null
  return (
    <DashCard
      title="Set up your books"
      testId="dash-onboarding"
      card={{ state: 'ready', data: checklist }}
      action={
        <span className="num text-caption text-muted">
          {checklist.doneCount}/{checklist.total} done
        </span>
      }
    >
      {(list) => (
        <Checklist
          bare
          title="Set up your books"
          columns={3}
          items={list.steps}
          testId="dash-onboarding-list"
          itemTestId="onboarding"
          onOpen={(id) => nav.go(onboardingScreen(list, id))}
        />
      )}
    </DashCard>
  )
}
