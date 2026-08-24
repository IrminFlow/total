import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts, type Screen } from '../state/stores'
import { Button, Money, Panel, ScrollList, Skeleton } from '../components/ui'
import { toDisplayDate, toDisplayDateTime, todayISO } from '@shared/dates'
import { upcomingDeadlines, type Deadline } from '@shared/compliance'
import { buildReminder } from '@shared/outstanding'
import type { RecurringTemplate } from '@shared/domain'
import type { CashSparkPoint, TileSparkKey, TopLedgerRow } from '@shared/reports'
import { Sparkline } from '../components/Sparkline'
import { templateOpenTarget } from './Recurring'

export function Gateway(): React.JSX.Element {
  const nav = useNav()
  const { from } = useSession()
  const today = todayISO()
  const { data } = useQuery({
    queryKey: ['dashboard', today, from],
    queryFn: () => api.reports.dashboard(today, from)
  })

  // Card letters are not handled here any more: they are registry accelerators bound by App's
  // `nav` keyboard layer, so they work from every screen rather than only this one.

  /**
   * Exactly six, and every one of them a figure.
   *
   * The row is six columns wide, so a seventh tile orphans onto a second row on its own. The
   * next GST deadline used to be that seventh: a sentence rather than an amount, wrapping to two
   * lines and standing a head taller than its neighbours. A due date is not a balance — it now
   * reads as a countdown on the compliance calendar, which is the panel that owns dates.
   */
  const tiles: { label: string; value: number; spark: TileSparkKey }[] = [
    { label: 'Cash in hand', value: data?.cashBalance ?? 0, spark: 'cash' },
    { label: 'Bank balance', value: data?.bankBalance ?? 0, spark: 'bank' },
    { label: 'Receivables', value: data?.receivables ?? 0, spark: 'receivables' },
    { label: 'Payables', value: data?.payables ?? 0, spark: 'payables' },
    { label: 'Sales this month', value: data?.monthSales ?? 0, spark: 'sales' },
    { label: 'GST payable', value: data?.gstPayable ?? 0, spark: 'gst' }
  ]
  // A figure with no history behind it is a figure nobody can judge: 4.2 lakh of receivables is
  // either a good month or a collections problem, and only the shape of the last twelve tells
  // you which. The line is anchored at zero (see Sparkline) so it cannot dramatise noise.
  const sparkFor = (key: TileSparkKey): { month: string; value: number }[] =>
    data?.tileSparks.find((s) => s.key === key)?.points ?? []

  return (
    <div className="mx-auto max-w-5xl">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((t) => (
          <Panel key={t.label} className="px-4 py-3">
            <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">{t.label}</p>
            {data === undefined ? (
              // Loading — a skeleton, not a misleading ₹0.00.
              <Skeleton className="mt-2.5 h-4 w-20" />
            ) : (
              <>
                <p className="num mt-1.5 text-title font-medium">
                  <Money paise={t.value} />
                </p>
                <Sparkline points={sparkFor(t.spark)} label={t.label} testId={`spark-tile-${t.spark}`} />
              </>
            )}
          </Panel>
        ))}
      </div>

      <DueTodayPanel />
      <CompliancePanel hasEmployees={data?.hasEmployees ?? false} dashboardLoaded={data !== undefined} />

      {/* The nine navigation cards that used to sit here were the sidebar again, in a second
          typeface size: the same nine destinations, the same accelerator letters, ~280px of the
          most valuable space on the screen, and nothing the rail on the left does not already
          say. The books' own numbers get that space instead. */}

      {/* Fixed row height: long receivable/payable lists scroll inside their panels instead of
          stretching the row — which would also stretch the sparkline opposite and make its
          aspect depend on how many debtors the company has. */}
      <GettingStarted />
      <LastBackupLine />

      <div className="mt-6 grid h-[420px] grid-cols-2 gap-3">
        <div className="flex min-h-0 flex-col gap-3">
          {/* Who to chase today comes before who owes the most: the largest debtor is usually
              the one who always pays, and the panel is only useful if it names someone to call.
              It falls back to the top-receivables list when nothing is overdue. */}
          <ChaseTodayPanel />
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
/** Whole days from `today` to an ISO date — negative once the date is behind us. */
function daysUntil(date: string, today: string): number {
  return Math.round((new Date(date + 'T00:00:00Z').getTime() - new Date(today + 'T00:00:00Z').getTime()) / 86400000)
}

export function deadlineCountdown(d: Deadline, today: string): string {
  const days = daysUntil(d.date, today)
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
  const filingFrequency = info?.gstFilingFrequency ?? 'monthly'
  const stateCode = info?.stateCode ?? ''

  const deadlines = useMemo(
    () => upcomingDeadlines(today, gstRegistrationType, hasEmployees, 30, filingFrequency, stateCode),
    [today, gstRegistrationType, hasEmployees]
  )
  const nearestGst = deadlines.find((d) => d.kind === 'gst') ?? null

  useEffect(() => {
    // Wait for the dashboard query to actually resolve, so `hasEmployees` (and hence PF/ESI
    // deadlines) reflects reality rather than the react-query default of `false`.
    if (!info || !slug || !dashboardLoaded || notifiedCompanies.has(slug)) return
    notifiedCompanies.add(slug)
    const soon = upcomingDeadlines(today, gstRegistrationType, hasEmployees, 3, filingFrequency, stateCode)
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
        <div className="flex items-baseline gap-3">
          <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">Compliance calendar</p>
          {/* The nearest GST return, read as a countdown rather than as a balance. */}
          {nearestGst && (
            <span
              data-testid="gateway-next-gst"
              className={`rounded-md px-1.5 py-0.5 text-hint font-medium whitespace-nowrap ${
                daysUntil(nearestGst.date, today) <= 3 ? 'bg-cr/10 text-cr' : 'bg-amber/15 text-amber'
              }`}
            >
              {deadlineCountdown(nearestGst, today)}
            </span>
          )}
        </div>
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

/** How many parties the chase list shows before it stops being a list and becomes a report. */
const CHASE_LIMIT = 5

/**
 * Who to chase today.
 *
 * The Gateway showed the five largest receivables, which is the wrong five: the largest debtor
 * is usually the one who always pays. This shows the five most overdue, with a one-tap reminder
 * beside each, because the answer to "who do I call this morning" should not require opening a
 * report.
 *
 * Falls back to naming the largest open balances when nothing is overdue, rather than showing an
 * empty panel — a business with everything within terms still wants to see where its money is.
 */
function ChaseTodayPanel(): React.JSX.Element {
  const nav = useNav()
  const { info, to } = useSession()
  const toast = useToasts()
  const { data } = useQuery({
    queryKey: ['khata', 'receivable', to],
    queryFn: () => api.analysis.khata('receivable', to)
  })

  const overdue = (data ?? []).filter((p) => p.worstOverdueDays > 0)
  const chasing = overdue.length > 0
  const rows = (chasing ? overdue : (data ?? []))
    .slice()
    .sort((a, b) =>
      chasing ? b.worstOverdueDays - a.worstOverdueDays || b.pending - a.pending : b.pending - a.pending
    )
    .slice(0, CHASE_LIMIT)

  const remind = (party: (typeof rows)[number]): void => {
    const reminder = buildReminder(
      { name: info?.name ?? 'We' },
      { name: party.name, email: party.email, phone: party.phone },
      []
    )
    if (!reminder.whatsapp) {
      toast.push('error', `No usable phone number for ${party.name}`)
      return
    }
    window.open(reminder.whatsapp, '_blank')
  }

  return (
    <Panel className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-baseline justify-between border-b border-line px-5 py-2.5">
        <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">
          {chasing ? 'Chase today' : 'Top receivables'}
        </p>
        <button
          className="text-hint text-muted hover:text-ink"
          data-testid="btn-gateway-open-khata"
          onClick={() => nav.go({ name: 'khata' })}
        >
          Khata →
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="rows-chase-today">
        {rows.length === 0 ? (
          <p className="px-5 py-3 text-hint text-muted">Nobody owes you anything.</p>
        ) : (
          rows.map((p) => (
            <div key={p.ledgerId} className="flex items-center gap-2 px-5 py-1.5 hover:bg-panel2">
              <button
                className="min-w-0 flex-1 truncate text-left text-detail"
                onClick={() => nav.go({ name: 'ledger-statement', ledgerId: p.ledgerId })}
              >
                {p.name}
                {p.worstOverdueDays > 0 && (
                  <span className="ml-2 num text-hint text-cr">{p.worstOverdueDays}d</span>
                )}
              </button>
              <Money paise={p.pending} className="text-detail" />
              {p.phone && (
                <button
                  className="shrink-0 text-hint text-blue hover:underline"
                  data-testid={`btn-chase-remind-${p.ledgerId}`}
                  onClick={() => remind(p)}
                >
                  Remind
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </Panel>
  )
}

/** A backup older than this is worth mentioning rather than leaving to be noticed. */
const STALE_BACKUP_HOURS = 48

/**
 * When the books were last backed up.
 *
 * Backups happen automatically on open and before anything risky, and until now the only way to
 * know they had was to open Settings. A one-line statement is enough: it is reassurance most
 * days and a warning on the day it matters, which is exactly the day nobody thinks to check.
 */
function LastBackupLine(): React.JSX.Element | null {
  const nav = useNav()
  const { data } = useQuery({ queryKey: ['backups'], queryFn: api.backups.list })
  if (!data) return null

  const latest = data.reduce<{ mtime: number } | null>((best, b) => (!best || b.mtime > best.mtime ? b : best), null)
  const hours = latest ? (Date.now() - latest.mtime) / 3_600_000 : Infinity
  const stale = hours > STALE_BACKUP_HOURS

  return (
    <p className={`mt-3 text-hint ${stale ? 'text-amber' : 'text-muted'}`} data-testid="gateway-last-backup">
      {latest ? (
        <>
          Last backup {toDisplayDateTime(new Date(latest.mtime))}
          {stale && ' — over two days ago'}
        </>
      ) : (
        'No backup yet'
      )}
      {' · '}
      <button
        className="text-blue hover:underline"
        data-testid="btn-gateway-backups"
        onClick={() => nav.go({ name: 'settings', tab: 'backups' })}
      >
        {data.length} kept
      </button>
    </p>
  )
}

/**
 * The getting-started checklist.
 *
 * Every step is derived from the books, so it cannot be ticked without doing the thing and it
 * reopens if the thing is undone. It disappears entirely once complete — a permanent checklist
 * on the main screen of an application someone uses daily is clutter, and the point is to be
 * finished with it.
 */
function GettingStarted(): React.JSX.Element | null {
  const nav = useNav()
  const { data } = useQuery({ queryKey: ['checklist'], queryFn: api.app.checklist })
  if (!data || data.complete) return null

  const remaining = data.steps.length - data.doneCount

  return (
    <Panel className="mt-4 p-4" data-testid="getting-started">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-body font-medium">
          Getting started — {data.doneCount} of {data.steps.length} done
        </p>
        <span className="text-hint text-muted">
          {remaining} step{remaining === 1 ? '' : 's'} left. This disappears when they are.
        </span>
      </div>
      <ol className="flex flex-col gap-1.5">
        {data.steps.map((step) => (
          <li key={step.id} className="flex items-baseline gap-2.5 text-body-sm">
            <span className={step.done ? 'text-dr' : 'text-muted'}>{step.done ? '✓' : '○'}</span>
            <span className={step.done ? 'text-muted line-through' : ''}>
              {step.screen && !step.done ? (
                <button
                  className="text-blue hover:underline"
                  data-testid={`btn-checklist-${step.id}`}
                  onClick={() => nav.go({ name: step.screen as Screen['name'] } as Screen)}
                >
                  {step.label}
                </button>
              ) : (
                step.label
              )}
              {!step.done && <span className="ml-2 text-hint text-muted">{step.why}</span>}
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  )
}
