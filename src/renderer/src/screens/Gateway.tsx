import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts, type Screen } from '../state/stores'
import { Accel, Button, Money, Panel, ScrollList, Skeleton } from '../components/ui'
import { toDisplayDate, todayISO } from '@shared/dates'
import { upcomingDeadlines, type Deadline } from '@shared/compliance'
import { useFeatures } from '../lib/useFeatures'
import type { RecurringTemplate } from '@shared/domain'
import type { CashSparkPoint, TopLedgerRow } from '@shared/reports'
import { templateOpenTarget } from './Recurring'
import { CARD_SCREENS } from '../lib/screens'

/** Cards derived from the single screen registry (lib/screens.ts). */
const CARDS: { name: string; label: string; sub: string; screen: Screen; accel?: string; feature?: (typeof CARD_SCREENS)[number]['feature'] }[] =
  CARD_SCREENS.map((s) => ({ name: s.name, label: s.title, sub: s.card.sub, screen: s.screen, accel: s.accel, feature: s.feature }))

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

  // Card letters are not handled here any more: they are registry accelerators bound by App's
  // `nav` keyboard layer, so they work from every screen rather than only this one.

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
            <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">{t.label}</p>
            {data === undefined && t.text === undefined ? (
              // Loading — a skeleton, not a misleading ₹0.00.
              <Skeleton className="mt-2.5 h-4 w-20" />
            ) : (
              <p className={`mt-1.5 text-title font-medium ${t.text ? '' : 'num'}`}>
                {t.text ?? <Money paise={t.value ?? 0} />}
              </p>
            )}
          </Panel>
        ))}
      </div>

      <DueTodayPanel />
      <CompliancePanel hasEmployees={data?.hasEmployees ?? false} dashboardLoaded={data !== undefined} />

      <div className="mt-6 grid grid-cols-3 gap-3">
        {cards.map((c) => (
          <button
            key={c.label}
            data-testid={`card-${c.name}`}
            onClick={() => nav.go(c.screen)}
            className="group rounded-lg border border-line bg-panel px-5 py-4 text-left transition-colors hover:border-amber/50"
          >
            <div className="flex items-center justify-between">
              <span className="text-lead font-medium">
                <Accel label={c.label} accel={c.accel} />
              </span>
              <span className="rounded-md border border-line px-1.5 text-label text-muted group-hover:border-amber/50 group-hover:text-amber">
                {c.accel}
              </span>
            </div>
            <p className="mt-1 text-small text-muted">{c.sub}</p>
          </button>
        ))}
      </div>

      {/* Fixed row height: long receivable/payable lists scroll inside their panels instead of
          stretching the row — which would also stretch the sparkline opposite and make its
          aspect depend on how many debtors the company has. */}
      <div className="mt-6 grid h-[420px] grid-cols-2 gap-3">
        <div className="flex min-h-0 flex-col gap-3">
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
            <p className="border-b border-line px-5 py-2.5 text-caption font-semibold tracking-[0.08em] text-muted uppercase">
              Recent entries
            </p>
            <ScrollList maxH="20rem">
              {data.recentVouchers.map((v) => (
                <button
                  key={v.voucherId}
                  className="flex w-full items-center gap-4 border-b border-line/40 px-5 py-2 text-left last:border-b-0 hover:bg-panel2"
                  onClick={() => nav.go({ name: 'voucher-entry', voucherId: v.voucherId })}
                >
                  <span className="num w-20 text-small text-muted">{toDisplayDate(v.date)}</span>
                  <span className="w-24 text-body-sm text-muted">{v.voucherType}</span>
                  <span className="num w-14 text-small text-muted">{v.number}</span>
                  <span className="flex-1 truncate text-detail">
                    {v.account}
                    {v.isOptional && (
                      <span data-testid="recent-badge-optional" className="ml-2 rounded-md bg-amber/15 px-1.5 py-0.5 text-label font-medium text-amber">Optional</span>
                    )}
                    {v.postDated && (
                      <span data-testid="recent-badge-pdc" className="ml-2 rounded-md bg-blue/10 px-1.5 py-0.5 text-label font-medium text-blue">PDC</span>
                    )}
                  </span>
                  <Money paise={v.debit} className="text-detail" />
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
        <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">Due today</p>
        <button className="text-hint text-blue hover:underline" onClick={() => nav.go({ name: 'recurring' })}>
          All recurring vouchers
        </button>
      </div>
      <div>
        {dueList.map((t) => (
          <div key={t.id} className="flex items-center gap-4 border-b border-line/40 px-5 py-2 last:border-b-0">
            <span className="num w-20 text-small text-muted">{toDisplayDate(t.nextDue)}</span>
            <span className="flex-1 truncate text-detail">{t.name}</span>
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

/** "GSTR-3B in 5 days" / "GSTR-1 tomorrow" / "GSTR-3B due today". Exported for renderer tests. */
export function deadlineCountdown(d: Deadline, today: string): string {
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
  const [showAll, setShowAll] = useState(false)
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
      // Deliberately fire-and-forget: an OS notification failing is not worth interrupting
      // the Gateway for — swallow the rejection.
      void api.app
        .notifyDeadlines(soon.map((d) => ({ title: d.form, body: `${d.title} — due ${toDisplayDate(d.date)}` })))
        .catch(() => {})
    }
    // Deliberately no dependency-driven re-fire within a company: the module set above is the
    // real guard, this effect just needs to run once `info`/`dashboardLoaded` are available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, slug, hasEmployees, dashboardLoaded])

  if (!deadlines.length) return null

  return (
    <Panel className="mt-6">
      <div className="flex items-center justify-between border-b border-line px-5 py-2.5">
        <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">Compliance calendar</p>
        <button className="text-hint text-blue hover:underline" onClick={() => nav.go({ name: 'gstr3b' })}>
          GSTR-3B
        </button>
      </div>
      <div>
        {(showAll ? deadlines : deadlines.slice(0, 6)).map((d) => (
          <div key={d.id} className="flex items-center gap-4 border-b border-line/40 px-5 py-2 last:border-b-0">
            <span className="num w-20 text-small text-muted">{toDisplayDate(d.date)}</span>
            <span className="w-28 text-body-sm text-muted">{d.form}</span>
            <span className="flex-1 truncate text-detail">{d.title}</span>
          </div>
        ))}
        {deadlines.length > 6 && (
          <button
            data-testid="btn-gateway-compliance-all"
            className="w-full px-5 py-2 text-left text-hint text-blue hover:underline"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? 'Show fewer' : `Show all ${deadlines.length}`}
          </button>
        )}
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
      <p className="border-b border-line px-5 py-2.5 text-caption font-semibold tracking-[0.08em] text-muted uppercase">
        Set up your books
      </p>
      <div>
        {steps.map((s) => (
          <button
            key={s.label}
            onClick={s.onClick}
            className="flex w-full items-center gap-3 border-b border-line/40 px-5 py-3 text-left last:border-b-0 hover:bg-panel2"
          >
            <span className={`text-lead ${s.done ? 'text-amber' : 'text-muted/60'}`}>{s.done ? '✓' : '○'}</span>
            <span className="flex-1">
              <span className={`block text-body ${s.done ? 'text-muted line-through' : 'text-ink'}`}>{s.label}</span>
              <span className="block text-hint text-muted/70">{s.hint}</span>
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
    <Panel className="flex min-h-0 flex-1 flex-col">
      <p className="shrink-0 border-b border-line px-5 py-2.5 text-caption font-semibold tracking-[0.08em] text-muted uppercase">
        {title}
      </p>
      {rows.length === 0 ? (
        <p className="px-5 py-6 text-center text-body-sm text-muted">Nothing outstanding</p>
      ) : (
        <ScrollList maxH="340px" className="min-h-0 flex-1">
          {rows.map((r) => (
            <button
              key={r.ledgerId}
              onClick={() => nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })}
              className="flex w-full items-center gap-3 border-b border-line/40 px-5 py-2 text-left last:border-b-0 hover:bg-panel2"
            >
              <span className="flex-1 truncate text-detail">{r.name}</span>
              <Money paise={r.amount} className="text-detail" />
            </button>
          ))}
        </ScrollList>
      )}
    </Panel>
  )
}

/** Inline SVG polyline — no chart library. `viewBox` is normalized to the point count so the
 *  path always fills the panel regardless of how many trailing days actually had data. The
 *  panel row it sits in is fixed-height, so the drawn aspect never shifts as sibling panels'
 *  content grows. Hovering reads out the date + balance under the cursor. */
function CashSparklinePanel({ points }: { points: CashSparkPoint[] }): React.JSX.Element {
  const w = 100
  const h = 32
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const values = points.map((p) => p.balance)
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const range = max - min || 1
  const xAt = (i: number): number => (points.length > 1 ? (i / (points.length - 1)) * w : w / 2)
  const yAt = (i: number): number => h - ((points[i]!.balance - min) / range) * h
  const coords = points.map((_, i) => `${xAt(i).toFixed(2)},${yAt(i).toFixed(2)}`).join(' ')
  const readout = hoverIdx != null ? points[hoverIdx] : points[points.length - 1]

  return (
    <Panel className="flex min-h-0 flex-col p-5">
      <div className="flex shrink-0 items-center justify-between">
        <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">Cash + bank · 30 days</p>
        {readout && (
          <p className="num text-detail">
            {hoverIdx != null && <span className="mr-2 text-muted">{toDisplayDate(readout.date)}</span>}
            <Money paise={readout.balance} />
          </p>
        )}
      </div>
      {points.length > 0 && (
        <svg
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          className="mt-4 min-h-0 w-full flex-1 text-blue"
          data-testid="spark-cash"
          role="img"
          aria-label="Cash and bank balance, last 30 days"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            const frac = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0
            const idx = Math.round(frac * (points.length - 1))
            setHoverIdx(Math.max(0, Math.min(points.length - 1, idx)))
          }}
          onMouseLeave={() => setHoverIdx(null)}
        >
          {points.length === 1 ? (
            // A one-point polyline draws nothing — show a flat line at the lone balance instead.
            <line x1={0} y1={yAt(0)} x2={w} y2={yAt(0)} stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          ) : (
            <polyline points={coords} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          )}
          {hoverIdx != null && (
            <line
              x1={xAt(hoverIdx)}
              y1={0}
              x2={xAt(hoverIdx)}
              y2={h}
              stroke="var(--t-amber)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      )}
    </Panel>
  )
}
