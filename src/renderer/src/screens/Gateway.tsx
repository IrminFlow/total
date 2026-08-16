import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts, type Screen } from '../state/stores'
import { Button, Money, Panel, ScrollList } from '../components/ui'
import { toDisplayDate, todayISO } from '@shared/dates'
import { upcomingDeadlines, type Deadline } from '@shared/compliance'
import { useFeatures } from '../lib/useFeatures'
import type { CompanyFeatures } from '@shared/features'
import type { RecurringTemplate } from '@shared/domain'
import type { CashSparkPoint, TopLedgerRow } from '@shared/reports'
import { templateOpenTarget } from './Recurring'

const CARDS: { label: string; sub: string; screen: Screen; key: string; feature?: keyof CompanyFeatures }[] = [
  { label: 'Voucher entry', sub: 'Sales, purchase, payment…', screen: { name: 'voucher-entry' }, key: 'V' },
  { label: 'Day book', sub: 'Every entry, in order', screen: { name: 'daybook' }, key: 'D' },
  { label: 'Masters', sub: 'Ledgers, items, groups', screen: { name: 'masters' }, key: 'M' },
  { label: 'Trial balance', sub: 'All closing balances', screen: { name: 'trial-balance' }, key: 'T' },
  { label: 'Profit & Loss', sub: 'Trading + P&L account', screen: { name: 'profit-loss' }, key: 'P' },
  { label: 'Balance sheet', sub: 'Assets and liabilities', screen: { name: 'balance-sheet' }, key: 'B' },
  { label: 'Stock summary', sub: 'Quantities and value', screen: { name: 'stock-summary' }, key: 'S', feature: 'inventory' },
  { label: 'GSTR-1', sub: 'Outward supplies return', screen: { name: 'gstr1' }, key: '1' },
  { label: 'GSTR-3B', sub: 'Summary return + ITC', screen: { name: 'gstr3b' }, key: '3' }
]

export function Gateway(): React.JSX.Element {
  const nav = useNav()
  const { from, info } = useSession()
  const today = todayISO()
  const features = useFeatures()
  const cards = useMemo(() => CARDS.filter((c) => !c.feature || features[c.feature]), [features])
  const { data } = useQuery({
    queryKey: ['dashboard', today, from],
    queryFn: () => api.reports.dashboard(today, from)
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      const card = cards.find((c) => c.key.toLowerCase() === e.key.toLowerCase())
      if (card) nav.go(card.screen)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nav, cards])

  const gstRegistrationType = info?.gstRegistrationType ?? 'unregistered'

  // hasPayroll doesn't matter for a 'gst'-kind deadline, so `false` is fine here.
  const nearestGst = useMemo(
    () =>
      gstRegistrationType === 'unregistered'
        ? null
        : (upcomingDeadlines(today, gstRegistrationType, false, 30).find((d) => d.kind === 'gst') ?? null),
    [today, gstRegistrationType]
  )

  const tiles: { label: string; value?: number; text?: string }[] = [
    { label: 'Cash in hand', value: data?.cashBalance ?? 0 },
    { label: 'Bank balance', value: data?.bankBalance ?? 0 },
    { label: 'Receivables', value: data?.receivables ?? 0 },
    { label: 'Payables', value: data?.payables ?? 0 },
    { label: 'Sales this month', value: data?.monthSales ?? 0 },
    { label: 'GST payable', value: data?.gstPayable ?? 0 }
  ]
  if (nearestGst) tiles.push({ label: 'Next GST due', text: deadlineCountdown(nearestGst, today) })

  return (
    <div className="mx-auto max-w-5xl">
      <div className="grid grid-cols-3 gap-3 lg:grid-cols-6">
        {tiles.map((t) => (
          <Panel key={t.label} className="px-4 py-3">
            <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">{t.label}</p>
            <p className={`mt-1.5 text-[16px] font-medium ${t.text ? '' : 'num'}`}>
              {t.text ?? <Money paise={t.value ?? 0} />}
            </p>
          </Panel>
        ))}
      </div>

      <DueTodayPanel />
      <CompliancePanel hasEmployees={data?.hasEmployees ?? false} dashboardLoaded={data !== undefined} />

      <div className="mt-6 grid grid-cols-3 gap-3">
        {cards.map((c) => (
          <button
            key={c.label}
            onClick={() => nav.go(c.screen)}
            className="group rounded-lg border border-line bg-panel px-5 py-4 text-left transition-colors hover:border-amber/50"
          >
            <div className="flex items-center justify-between">
              <span className="text-[14.5px] font-medium">{c.label}</span>
              <span className="rounded border border-line px-1.5 text-[10.5px] text-muted group-hover:border-amber/50 group-hover:text-amber">
                {c.key}
              </span>
            </div>
            <p className="mt-1 text-[12px] text-muted">{c.sub}</p>
          </button>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-3">
          <TopLedgersPanel title="Top receivables" rows={data?.topReceivables ?? []} />
          <TopLedgersPanel title="Top payables" rows={data?.topPayables ?? []} />
        </div>
        <CashSparklinePanel points={data?.cashSpark ?? []} />
      </div>

      {data && data.voucherCount === 0 ? (
        <OnboardingChecklist partyCount={data.partyCount} itemCount={data.itemCount} />
      ) : (
        data &&
        data.recentVouchers.length > 0 && (
          <Panel className="mt-6">
            <p className="border-b border-line px-5 py-2.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
              Recent entries
            </p>
            <ScrollList maxH="20rem">
              {data.recentVouchers.map((v) => (
                <button
                  key={v.voucherId}
                  className="flex w-full items-center gap-4 border-b border-line/40 px-5 py-2 text-left last:border-b-0 hover:bg-panel2"
                  onClick={() => nav.go({ name: 'voucher-entry', voucherId: v.voucherId })}
                >
                  <span className="num w-20 text-[12px] text-muted">{toDisplayDate(v.date)}</span>
                  <span className="w-24 text-[12.5px] text-muted">{v.voucherType}</span>
                  <span className="num w-14 text-[12px] text-muted">{v.number}</span>
                  <span className="flex-1 truncate text-[13px]">{v.account}</span>
                  <Money paise={v.debit} className="text-[13px]" />
                </button>
              ))}
            </ScrollList>
          </Panel>
        )
      )}
    </div>
  )
}

function DueTodayPanel(): React.JSX.Element | null {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const today = todayISO()
  const { data: dueList } = useQuery({ queryKey: ['recurring', 'due', today], queryFn: () => api.recurring.due(today) })
  const [busyId, setBusyId] = useState<number | null>(null)

  if (!dueList?.length) return null

  const post = async (t: RecurringTemplate): Promise<void> => {
    setBusyId(t.id)
    try {
      const saved = await api.recurring.post(t.id, today)
      await queryClient.invalidateQueries()
      toast.push('success', `${saved.number} posted from "${t.name}"`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const skip = async (t: RecurringTemplate): Promise<void> => {
    setBusyId(t.id)
    try {
      await api.recurring.skip(t.id)
      await queryClient.invalidateQueries()
      toast.push('success', `"${t.name}" skipped`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const openInVoucherEntry = (t: RecurringTemplate): void => {
    const { screen, warnInvoice } = templateOpenTarget(t)
    if (warnInvoice) toast.push('warning', 'Line items must be re-entered for invoice types')
    nav.go(screen)
  }

  return (
    <Panel className="mt-6">
      <div className="flex items-center justify-between border-b border-line px-5 py-2.5">
        <p className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Due today</p>
        <button className="text-[11.5px] text-blue hover:underline" onClick={() => nav.go({ name: 'recurring' })}>
          All recurring vouchers
        </button>
      </div>
      <div>
        {dueList.map((t) => (
          <div key={t.id} className="flex items-center gap-4 border-b border-line/40 px-5 py-2 last:border-b-0">
            <span className="num w-20 text-[12px] text-muted">{toDisplayDate(t.nextDue)}</span>
            <span className="flex-1 truncate text-[13px]">{t.name}</span>
            <Button disabled={busyId === t.id} onClick={() => void post(t)}>
              Post
            </Button>
            <Button disabled={busyId === t.id} onClick={() => void skip(t)}>
              Skip
            </Button>
            <Button variant="ghost" disabled={busyId === t.id} onClick={() => openInVoucherEntry(t)}>
              Open in voucher entry
            </Button>
          </div>
        ))}
      </div>
    </Panel>
  )
}

/** "GSTR-3B in 5 days" / "GSTR-1 tomorrow" / "GSTR-3B due today". */
function deadlineCountdown(d: Deadline, today: string): string {
  const days = Math.round(
    (new Date(d.date + 'T00:00:00Z').getTime() - new Date(today + 'T00:00:00Z').getTime()) / 86400000
  )
  if (days <= 0) return `${d.form} due today`
  if (days === 1) return `${d.form} tomorrow`
  return `${d.form} in ${days} days`
}

/** Fires once per company per app session (not per Gateway mount/remount) — a module-level set
 *  rather than component state, so navigating away and back to the Gateway doesn't re-notify,
 *  but switching companies does get its own notification. Keyed by company slug. */
const notifiedCompanies = new Set<string>()

function CompliancePanel({
  hasEmployees,
  dashboardLoaded
}: {
  hasEmployees: boolean
  dashboardLoaded: boolean
}): React.JSX.Element | null {
  const nav = useNav()
  const { info, slug } = useSession()
  const today = todayISO()
  const gstRegistrationType = info?.gstRegistrationType ?? 'unregistered'

  const deadlines = useMemo(
    () => upcomingDeadlines(today, gstRegistrationType, hasEmployees, 30),
    [today, gstRegistrationType, hasEmployees]
  )

  useEffect(() => {
    // Wait for the dashboard query to actually resolve, so `hasEmployees` (and hence PF/ESI
    // deadlines) reflects reality rather than the react-query default of `false`.
    if (!info || !slug || !dashboardLoaded || notifiedCompanies.has(slug)) return
    notifiedCompanies.add(slug)
    const soon = upcomingDeadlines(today, gstRegistrationType, hasEmployees, 3)
    if (soon.length) {
      void api.app.notifyDeadlines(
        soon.map((d) => ({ title: d.form, body: `${d.title} — due ${toDisplayDate(d.date)}` }))
      )
    }
    // Deliberately no dependency-driven re-fire within a company: the module set above is the
    // real guard, this effect just needs to run once `info`/`dashboardLoaded` are available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, slug, hasEmployees, dashboardLoaded])

  if (!deadlines.length) return null

  return (
    <Panel className="mt-6">
      <div className="flex items-center justify-between border-b border-line px-5 py-2.5">
        <p className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Compliance calendar</p>
        <button className="text-[11.5px] text-blue hover:underline" onClick={() => nav.go({ name: 'gstr3b' })}>
          GSTR-3B
        </button>
      </div>
      <div>
        {deadlines.slice(0, 6).map((d) => (
          <div key={d.id} className="flex items-center gap-4 border-b border-line/40 px-5 py-2 last:border-b-0">
            <span className="num w-20 text-[12px] text-muted">{toDisplayDate(d.date)}</span>
            <span className="w-28 text-[12.5px] text-muted">{d.form}</span>
            <span className="flex-1 truncate text-[13px]">{d.title}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

/** Replaces "Recent entries" for a brand-new company (voucherCount === 0) with a short setup
 *  checklist — each step's "done" check is derived from data the dashboard already fetched, no
 *  extra round-trip. Disappears on its own once the first voucher is posted. */
function OnboardingChecklist({ partyCount, itemCount }: { partyCount: number; itemCount: number }): React.JSX.Element {
  const nav = useNav()
  const steps = [
    {
      label: 'Import your books from Tally',
      hint: 'Or start from scratch — either way, head to Company info',
      done: partyCount > 0 || itemCount > 0,
      onClick: () => nav.go({ name: 'import-tally' })
    },
    {
      label: 'Add a party and an item',
      hint: 'Masters → Ledgers / Stock items',
      done: partyCount > 0 && itemCount > 0,
      onClick: () => nav.go({ name: 'masters' })
    },
    {
      label: 'Post your first invoice',
      hint: 'Voucher entry, F8 for Sales',
      done: false,
      onClick: () => nav.go({ name: 'voucher-entry', kindHint: 'sales' })
    }
  ]

  return (
    <Panel className="mt-6">
      <p className="border-b border-line px-5 py-2.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
        Set up your books
      </p>
      <div>
        {steps.map((s) => (
          <button
            key={s.label}
            onClick={s.onClick}
            className="flex w-full items-center gap-3 border-b border-line/40 px-5 py-3 text-left last:border-b-0 hover:bg-panel2"
          >
            <span className={`text-[15px] ${s.done ? 'text-amber' : 'text-muted/60'}`}>{s.done ? '✓' : '○'}</span>
            <span className="flex-1">
              <span className={`block text-[13.5px] ${s.done ? 'text-muted line-through' : 'text-ink'}`}>{s.label}</span>
              <span className="block text-[11.5px] text-muted/70">{s.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </Panel>
  )
}

/** Shared by "Top receivables" / "Top payables" — rows navigate straight to the ledger's statement. */
function TopLedgersPanel({ title, rows }: { title: string; rows: TopLedgerRow[] }): React.JSX.Element {
  const nav = useNav()
  return (
    <Panel className="flex-1">
      <p className="border-b border-line px-5 py-2.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
        {title}
      </p>
      {rows.length === 0 ? (
        <p className="px-5 py-6 text-center text-[12.5px] text-muted">Nothing outstanding</p>
      ) : (
        <ScrollList maxH="15rem">
          {rows.map((r) => (
            <button
              key={r.ledgerId}
              onClick={() => nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })}
              className="flex w-full items-center gap-3 border-b border-line/40 px-5 py-2 text-left last:border-b-0 hover:bg-panel2"
            >
              <span className="flex-1 truncate text-[13px]">{r.name}</span>
              <Money paise={r.amount} className="text-[13px]" />
            </button>
          ))}
        </ScrollList>
      )}
    </Panel>
  )
}

/** Inline SVG polyline — no chart library. `viewBox` is normalized to the point count so the
 *  path always fills the panel regardless of how many trailing days actually had data. */
function CashSparklinePanel({ points }: { points: CashSparkPoint[] }): React.JSX.Element {
  const w = 100
  const h = 32
  const values = points.map((p) => p.balance)
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const range = max - min || 1
  const coords = points
    .map((p, i) => {
      const x = points.length > 1 ? (i / (points.length - 1)) * w : 0
      const y = h - ((p.balance - min) / range) * h
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
  const last = points[points.length - 1]

  return (
    <Panel className="flex flex-1 flex-col p-5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Cash + bank · 30 days</p>
        {last && <Money paise={last.balance} className="text-[13px]" />}
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="mt-4 h-24 w-full flex-1 text-blue"
        aria-hidden="true"
      >
        <polyline points={coords} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </Panel>
  )
}
