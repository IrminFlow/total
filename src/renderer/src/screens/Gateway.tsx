// Gateway — the company dashboard (WP 1.10b). Figures come from report:dashboardSeries (sectioned:
// each card renders its own section, loading skeleton or error) plus the older report:dashboard
// for recent entries and the payroll flag. Every number reconciles to a report screen and every
// tile/row clicks through to it. The working period is the session's from/to; "this month" is
// today's month while today is inside that period, else the period's last month (see
// dashboardWindow in @shared/dashboard).
//
// Keyboard: every tile, card link and list row is a Tab stop (drill rows: Enter opens the
// statement, the ledger name its edit window). Lists here are short (≤ 8 rows) and several sit
// side by side, so they use plain focusable rows rather than useKeyNav — a window-level ↑/↓ owner
// would be ambiguous between six lists. Charts take focus and read out months with ←/→.
// Single-letter keys still jump to screens (registry cards) and F4–F9 start a voucher.
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts, type Screen } from '../state/stores'
import { Button, DrawerSection, isAnyModalOpen, Kbd, Money, Page, PageHeader, StatTile } from '../components/ui'
import { OptionToggle, useScreenOptions } from '../components/ScreenOptions'
import { fyOf, toDisplayDate, toMonthLabel, todayISO } from '@shared/dates'
import { formatPaiseCompact } from '@shared/money'
import type { Deadline } from '@shared/compliance'
import type { DashAgeing, DashCash, DashSection, DashTrade, DashboardSeries, DashboardWindow } from '@shared/dashboard'

type SectionKey = Exclude<keyof DashboardSeries, 'window'>
type SectionData<K extends SectionKey> = DashboardSeries[K] extends DashSection<infer D> ? D : never
import { useFeatures } from '../lib/useFeatures'
import { CARD_SCREENS } from '../lib/screens'
import { isManufactureKey, kindForVoucherKey } from '../lib/voucherKeys'
import { Sparkline } from '../components/charts'
import { cardState, type CardState } from './gateway/parts'
import {
  AgeingCard,
  BooksCard,
  CashCard,
  ComplianceCard,
  OnboardingCard,
  ProfitChartCard,
  RecentCard,
  StockCard,
  TopPartiesCard,
  TradeChartCard
} from './gateway/cards'

/** Single-letter screen shortcuts, from the screen registry (lib/screens.ts). */
const SHORTCUTS: { key: string; screen: Screen; feature?: (typeof CARD_SCREENS)[number]['feature'] }[] = CARD_SCREENS.map((s) => ({
  key: s.card.key,
  screen: s.screen,
  feature: s.feature
}))

const QUICK_VOUCHERS: { kind: 'sales' | 'purchase' | 'receipt' | 'payment' | 'journal'; label: string; key: string }[] = [
  { kind: 'sales', label: 'Sales', key: 'F8' },
  { kind: 'purchase', label: 'Purchase', key: 'F9' },
  { kind: 'receipt', label: 'Receipt', key: 'F6' },
  { kind: 'payment', label: 'Payment', key: 'F5' },
  { kind: 'journal', label: 'Journal', key: 'F7' }
]

export function Gateway(): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { from, to } = useSession()
  const today = todayISO()
  const features = useFeatures()
  const shortcuts = useMemo(() => SHORTCUTS.filter((c) => !c.feature || features[c.feature]), [features])

  const seriesQ = useQuery({
    queryKey: ['dashboard', 'series', today, from, to],
    queryFn: () => api.reports.dashboardSeries(today, from, to)
  })
  // Same key VoucherEntry uses (react-query dedupes): recent entries + the payroll flag.
  const dashQ = useQuery({ queryKey: ['dashboard', today, from], queryFn: () => api.reports.dashboard(today, from) })

  const s: DashboardSeries | undefined = seriesQ.data
  const card = <K extends SectionKey>(k: K): CardState<SectionData<K>> =>
    cardState(seriesQ, s?.[k] as DashSection<SectionData<K>> | undefined)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // A key aimed at an open dialog must never double as a Gateway shortcut underneath it.
      if (isAnyModalOpen()) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      const kind = kindForVoucherKey(e, { stockNotes: features.inventory && features.orders })
      if (kind) {
        e.preventDefault()
        nav.go({ name: 'voucher-entry', kindHint: kind })
        return
      }
      if (isManufactureKey(e)) {
        e.preventDefault()
        if (features.inventory) nav.go({ name: 'manufacture' })
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const sc = shortcuts.find((c) => c.key.toLowerCase() === e.key.toLowerCase())
      if (sc) nav.go(sc.screen)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nav, shortcuts, features.inventory, features.orders])

  const [backingUp, setBackingUp] = useState(false)
  const backupNow = async (): Promise<void> => {
    setBackingUp(true)
    try {
      const r = await api.backups.run()
      toast.push('success', `Backup saved — ${r.path.split('/').pop()}`)
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBackingUp(false)
    }
  }

  const fy = fyOf(from)
  const periodLabel = from === fy.from && to === fy.to ? `FY ${fy.label}` : `${toDisplayDate(from)} → ${toDisplayDate(to)}`
  const w = s?.window
  const setup = s?.setup.ok ? s.setup.data : null
  const brandNew = setup?.voucherCount === 0
  const hasPayroll = features.payroll && (dashQ.data?.hasEmployees ?? false)
  const opts = useScreenOptions('gateway', { charts: true, parties: true, activity: true })

  return (
    <Page width="full" className="flex flex-col gap-3" data-testid="gateway-dashboard">
      <PageHeader
        title="Dashboard"
        className="!mb-0"
        period={
          <span data-testid="gateway-period">
            {periodLabel}
            {w && <> · as on {toDisplayDate(w.asOn)}</>}
          </span>
        }
        actions={
          <nav aria-label="New voucher" className="flex flex-wrap items-center gap-1.5">
            <span className="mr-0.5 text-caption text-muted">New</span>
            {QUICK_VOUCHERS.map((q) => (
              <Button
                key={q.kind}
                size="sm"
                data-testid={`quick-${q.kind}`}
                onClick={() => nav.go({ name: 'voucher-entry', kindHint: q.kind })}
              >
                {q.label} <Kbd>{q.key}</Kbd>
              </Button>
            ))}
          </nav>
        }
        secondary={
          <>
            <Button size="sm" data-testid="quick-backup" loading={backingUp} onClick={() => void backupNow()}>
              {backingUp ? 'Backing up…' : 'Back up now'}
            </Button>
            <Button size="sm" data-testid="quick-import" onClick={() => nav.go({ name: 'import-tally' })}>
              Import
            </Button>
          </>
        }
        options={{
          onReset: opts.reset,
          content: (
            <DrawerSection title="Cards">
              <OptionToggle
                label="Sales & profit charts"
                checked={opts.options.charts}
                onChange={(v) => opts.set('charts', v)}
                testId="input-gateway-charts"
              />
              <OptionToggle
                label="Ageing, top parties & compliance"
                checked={opts.options.parties}
                onChange={(v) => opts.set('parties', v)}
                testId="input-gateway-parties"
              />
              <OptionToggle
                label="Recent entries, cash & books"
                checked={opts.options.activity}
                onChange={(v) => opts.set('activity', v)}
                testId="input-gateway-activity"
              />
              <p className="text-hint text-muted">The headline figures and the setup checklist always show.</p>
            </DrawerSection>
          )
        }}
      />

      {brandNew && setup && <OnboardingCard setup={setup} />}

      <StatTiles window={w} cash={card('cash')} receivables={card('receivables')} payables={card('payables')} trade={card('trade')} />

      {opts.options.charts && (
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-12 lg:col-span-7">
            <TradeChartCard card={card('trade')} window={w} />
          </div>
          <div className="col-span-12 lg:col-span-5">
            <ProfitChartCard card={card('trade')} window={w} />
          </div>
        </div>
      )}

      {opts.options.parties && (
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-6 xl:col-span-3">
            <AgeingCard receivables={card('receivables')} payables={card('payables')} />
          </div>
          <div className="col-span-6 xl:col-span-3">
            <TopPartiesCard title="Top customers" testId="dash-top-customers" card={card('topCustomers')} empty="No sales in this period" />
          </div>
          <div className="col-span-6 xl:col-span-3">
            <TopPartiesCard
              title="Top suppliers"
              testId="dash-top-suppliers"
              card={card('topSuppliers')}
              empty="No purchases in this period"
            />
          </div>
          <div className="col-span-6 xl:col-span-3">
            <ComplianceCard
              gst={card('gst')}
              tds={features.tds ? card('tds') : null}
              hasPayroll={hasPayroll}
              dashboardLoaded={dashQ.data !== undefined}
              pdc={s?.pdc?.ok ? s.pdc.data : null}
            />
          </div>
        </div>
      )}

      {opts.options.activity && (
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-12 xl:col-span-6">
            <RecentCard rows={dashQ.data?.recentVouchers} />
          </div>
          <div className={`col-span-6 ${features.inventory ? 'xl:col-span-3' : 'xl:col-span-6'} flex flex-col gap-3`}>
            <CashCard card={card('cash')} />
            <BooksCard activity={card('activity')} status={card('status')} onBackup={() => void backupNow()} backingUp={backingUp} />
          </div>
          {features.inventory && (
            <div className="col-span-6 xl:col-span-3">
              <StockCard card={card('stock')} />
            </div>
          )}
        </div>
      )}

      {!brandNew && setup && <OnboardingCard setup={setup} />}
    </Page>
  )
}

/** The headline row: six figures with a 6-month trend each, each a click-through. */
function StatTiles({
  window: w,
  cash,
  receivables: rec,
  payables: pay,
  trade
}: {
  window: DashboardWindow | undefined
  cash: CardState<DashCash>
  receivables: CardState<DashAgeing>
  payables: CardState<DashAgeing>
  trade: CardState<DashTrade>
}): React.JSX.Element {
  const nav = useNav()
  const sparkOf = (t: DashTrade, pick: (m: DashTrade['months'][number]) => number): number[] =>
    (w?.sparkMonths ?? []).map((m) => {
      const row = t.months.find((x) => x.month === m)
      return row ? pick(row) : 0
    })
  const focus = w && trade.state === 'ready' ? trade.data.months.find((m) => m.month === w.focusMonth) : undefined
  const focusLabel = w ? `${toMonthLabel(w.focusMonth, 'long')}${w.focusMonth === w.today.slice(0, 7) ? ' to date' : ''}` : ''
  const overdue = (a: CardState<DashAgeing>): string =>
    a.state === 'ready'
      ? `${a.data.parties} ${a.data.parties === 1 ? 'party' : 'parties'} · ${formatPaiseCompact(a.data.buckets[1] + a.data.buckets[2] + a.data.buckets[3])} over 30 days`
      : ''
  const err = (c: CardState<unknown>): string | null => (c.state === 'error' ? c.error : null)
  const fy = w ? fyOf(w.from) : null
  const profitSub = w && fy ? `${w.from === fy.from && w.to === fy.to ? `FY ${fy.label}` : 'Period'} to ${toDisplayDate(w.asOn)}` : ''

  return (
    <ul className="grid grid-cols-3 gap-3 xl:grid-cols-6" aria-label="Key figures">
      <li className="min-w-0">
        <StatTile
          size="lg"
          label="Cash & bank"
          testId="tile-cash"
          loading={cash.state === 'loading'}
          error={err(cash)}
          value={cash.state === 'ready' && <Money paise={cash.data.total} />}
          footer={cash.state === 'ready' && `Cash ${formatPaiseCompact(cash.data.cash)} · Bank ${formatPaiseCompact(cash.data.bank)}`}
          reserveSparkline
          sparkline={
            cash.state === 'ready' && (
              <Sparkline
                testId="spark-cash"
                values={cash.data.trend.map((p) => p.amount)}
                color="ink"
                label="Cash and bank at month end, last 6 months"
              />
            )
          }
          onClick={() => nav.go({ name: 'cash-flow' })}
          openLabel="Open the cash flow statement"
        />
      </li>
      <li className="min-w-0">
        <StatTile
          size="lg"
          label="Receivables"
          testId="tile-receivables"
          loading={rec.state === 'loading'}
          error={err(rec)}
          value={rec.state === 'ready' && <Money paise={rec.data.total} />}
          footer={overdue(rec)}
          reserveSparkline
          sparkline={
            rec.state === 'ready' && (
              <Sparkline values={rec.data.trend.map((p) => p.amount)} color="blue" label="Owed to you at month end, last 6 months" />
            )
          }
          onClick={() => nav.go({ name: 'outstandings' })}
          openLabel="Open Outstandings"
        />
      </li>
      <li className="min-w-0">
        <StatTile
          size="lg"
          label="Payables"
          testId="tile-payables"
          loading={pay.state === 'loading'}
          error={err(pay)}
          value={pay.state === 'ready' && <Money paise={pay.data.total} />}
          footer={overdue(pay)}
          reserveSparkline
          sparkline={
            pay.state === 'ready' && (
              <Sparkline values={pay.data.trend.map((p) => p.amount)} color="amber" label="You owe at month end, last 6 months" />
            )
          }
          onClick={() => nav.go({ name: 'outstandings' })}
          openLabel="Open Outstandings"
        />
      </li>
      <li className="min-w-0">
        <StatTile
          size="lg"
          label="Month sales"
          testId="tile-sales"
          loading={trade.state === 'loading'}
          error={err(trade)}
          value={trade.state === 'ready' && <Money paise={focus?.sales ?? 0} />}
          footer={focusLabel}
          reserveSparkline
          sparkline={
            trade.state === 'ready' && (
              <Sparkline values={sparkOf(trade.data, (m) => m.sales)} color="blue" label="Sales by month, last 6 months" />
            )
          }
          onClick={() => nav.go({ name: 'registers' })}
          openLabel="Open the sales register"
        />
      </li>
      <li className="min-w-0">
        <StatTile
          size="lg"
          label="Month purchases"
          testId="tile-purchases"
          loading={trade.state === 'loading'}
          error={err(trade)}
          value={trade.state === 'ready' && <Money paise={focus?.purchases ?? 0} />}
          footer={focusLabel}
          reserveSparkline
          sparkline={
            trade.state === 'ready' && (
              <Sparkline values={sparkOf(trade.data, (m) => m.purchases)} color="amber" label="Purchases by month, last 6 months" />
            )
          }
          onClick={() => nav.go({ name: 'registers' })}
          openLabel="Open the purchase register"
        />
      </li>
      <li className="min-w-0">
        <StatTile
          size="lg"
          label="Net profit"
          testId="tile-profit"
          loading={trade.state === 'loading'}
          error={err(trade)}
          value={
            trade.state === 'ready' && (
              <span className={trade.data.periodNetProfit < 0 ? 'text-cr' : 'text-dr'}>
                <Money paise={trade.data.periodNetProfit} />
              </span>
            )
          }
          footer={profitSub}
          reserveSparkline
          sparkline={
            trade.state === 'ready' && (
              <Sparkline
                values={sparkOf(trade.data, (m) => m.netProfit)}
                color="dr"
                negativeColor="cr"
                label="Net profit by month, last 6 months"
              />
            )
          }
          onClick={() => nav.go({ name: 'profit-loss' })}
          openLabel="Open Profit & Loss"
        />
      </li>
    </ul>
  )
}

/** "GSTR-3B in 5 days" / "GSTR-1 tomorrow" / "GSTR-3B due today". Exported for renderer tests. */
export function deadlineCountdown(d: Deadline, today: string): string {
  const days = Math.round((new Date(d.date + 'T00:00:00Z').getTime() - new Date(today + 'T00:00:00Z').getTime()) / 86400000)
  if (days <= 0) return `${d.form} due today`
  if (days === 1) return `${d.form} tomorrow`
  return `${d.form} in ${days} days`
}
