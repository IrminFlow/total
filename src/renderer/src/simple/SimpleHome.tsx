import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { onboardingScreen } from '../lib/onboarding'
import { useNav } from '../state/stores'
import { Page } from '../components/ui'
import { Button, SkeletonTiles, Why } from '../components/kit'
import { OpeningsHomeCard } from './OpeningsHomeCard'
import { HOME_TASKS, accountScreen, attentionScreen, deadlineScreen, homeReportScreen, type HomeReport } from './homeTasks'
import { onboardingFromDashSetup, type OnboardingChecklist, type OnboardingStepId } from '@shared/onboarding'
import { todayISO, toPlainDate } from '@shared/dates'
import type { MessageKey } from '@shared/i18n'
import { homeAttentionRows, isEmptyHome, owedAttention, type HomeGst, type SimpleHomeData } from '@shared/simple/home'
import {
  attentionText, cashWhy, deadlineText, deadlineWhy, gstLine, gstLinkLabel, gstWhy, homeProfitWhy, money, monthCompareWhy, moneyInWhy, moneyOutWhy, payablesWhy, profitSentence,
  receivablesWhy
} from '@shared/simple/explain'

/** Plain labels for the onboarding steps, keyed by step id (the step logic stays in onboarding.ts).
 *  WP 8.7's "Enter what you had on day one" is its own card (OpeningsHomeCard) above them. */
const STEP_LABEL: Record<OnboardingStepId, { label: MessageKey; hint: MessageKey }> = {
  company: { label: 'simple.setupSteps.company.label', hint: 'simple.setupSteps.company.hint' },
  gstin: { label: 'simple.setupSteps.gstin.label', hint: 'simple.setupSteps.gstin.hint' },
  ledger: { label: 'simple.setupSteps.ledger.label', hint: 'simple.setupSteps.ledger.hint' },
  bank: { label: 'simple.setupSteps.bank.label', hint: 'simple.setupSteps.bank.hint' },
  voucher: { label: 'simple.setupSteps.voucher.label', hint: 'simple.setupSteps.voucher.hint' },
  invoice: { label: 'simple.setupSteps.invoice.label', hint: 'simple.setupSteps.invoice.hint' },
  backup: { label: 'simple.setupSteps.backup.label', hint: 'simple.setupSteps.backup.hint' }
}

const cardCls = 'rounded-lg border border-line bg-panel p-panel shadow-elev-1'

/**
 * WP 8.6: the simple Home — today's money in / out, who owes whom, cash and bank, GST due (regular
 * registrations), how the business is doing, the task buttons, what needs attention, what is
 * coming up and the setup checklist. Everything comes from ONE call (`simple:home`) whose figures
 * are the accountant screens' own services as on today; each figure's "Why?" sentence is a pure
 * function of those figures (shared/simple/explain.ts).
 */
export function SimpleHome(): React.JSX.Element {
  const t = useT()
  const today = todayISO()
  const homeQ = useQuery({
    queryKey: ['simple', 'home', today], // i18n-technical
    queryFn: () => api.simple.home(today)
  })
  const home = homeQ.data

  return (
    <Page data-testid="simple-home">
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.home.title')}</h1>
        <span className="text-small text-muted" data-testid="simple-home-date">
          {t('simple.home.asOn', { date: toPlainDate(today) })}
        </span>
      </div>

      <Tasks />

      {homeQ.isError && (
        <section className={`${cardCls} mt-5`} data-testid="simple-home-error">
          <p className="text-detail text-ink">{t('simple.home.loadError')}</p>
          <Button className="mt-3" variant="secondary" size="sm" onClick={() => void homeQ.refetch()}>
            {t('common.tryAgain')}
          </Button>
        </section>
      )}
      {!home && !homeQ.isError && (
        <div className="mt-5">
          <SkeletonTiles count={3} />
        </div>
      )}
      {home && <HomeBody home={home} />}
    </Page>
  )
}

function Tasks(): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  return (
    <nav aria-label={t('simple.home.tasks')} className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {HOME_TASKS.map((task) => (
        <button
          key={task.id}
          type="button"
          data-testid={`simple-task-${task.id}`}
          onClick={() => nav.go(task.screen)}
          className="rounded-lg border border-amber/50 bg-amber/10 px-panel py-4 text-center text-lead font-semibold text-ink shadow-elev-1 transition-colors hover:border-amber hover:bg-amber/20 focus-visible:border-amber"
        >
          {t(task.label) /* i18n-technical: keyed in homeTasks.ts */}
        </button>
      ))}
    </nav>
  )
}

function HomeBody({ home }: { home: SimpleHomeData }): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const checklist = onboardingFromDashSetup(home.setup)
  const gstRegular = home.gst?.kind === 'regular' ? (home.gst as Extract<HomeGst, { kind: 'regular' }>) : null
  // Each link says what it opens, and opens that figure (same date, side, period).
  const link = (id: HomeReport, label: string): { label: string; onOpen: () => void } => ({ label, onOpen: () => nav.go(homeReportScreen(id, home)) })
  const links = {
    day: link('day', t('simple.home.link.day')), // i18n-technical
    receivables: link('receivables', t('simple.home.link.receivables')), // i18n-technical
    payables: link('payables', t('simple.home.link.payables')), // i18n-technical
    cash: link('cash', t('simple.home.link.cash')), // i18n-technical
    profit: link('profit', t('simple.home.link.profit')), // i18n-technical
    gst: link('gst', gstRegular ? gstLinkLabel(gstRegular, t) : '') // i18n-technical
  }
  const empty = isEmptyHome(home)
  const backupsScreen = homeReportScreen('backups', home) // i18n-technical

  return (
    <>
      {home.gstAnswer === 'not_sure' && (
        <section className={`${cardCls} mt-5`} data-testid="simple-home-not-sure-gst">
          <h2 className="text-lead font-semibold text-ink">{t('simple.home.notSureGstTitle')}</h2>
          <p className="mt-1 text-detail text-muted">{t('simple.home.notSureGstHint')}</p>
        </section>
      )}

      <OpeningsHomeCard owed={{ receivables: home.receivables.total, payables: home.payables.total }} />

      {empty && <EmptyHome checklist={checklist} />}

      {!empty && (
      <ul className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Tile
          id="money-in"
          title={t('simple.home.moneyInToday')}
          paise={home.moneyIn.amount}
          why={moneyInWhy(home.moneyIn, t)}
          link={links.day}
        />
        <Tile
          id="money-out"
          title={t('simple.home.moneyOutToday')}
          paise={home.moneyOut.amount}
          why={moneyOutWhy(home.moneyOut, t)}
          link={links.day}
        />
        <Tile
          id="cash"
          title={t('simple.home.cashAndBank')}
          paise={home.cash.total}
          why={cashWhy(home.cash, t)}
          link={links.cash}
        >
          {home.cash.accounts.length > 0 && (
            <ul className="mt-2 flex flex-col gap-0.5" data-testid="simple-home-accounts">
              {home.cash.accounts.map((a) => (
                <li key={a.ledgerId}>
                  <button
                    type="button"
                    data-testid={`simple-home-account-${a.ledgerId}`}
                    data-paise={a.balance}
                    onClick={() => nav.go(accountScreen(a.ledgerId))}
                    className="flex w-full items-baseline justify-between gap-3 text-left text-small hover:underline"
                  >
                    <span className="min-w-0 truncate text-muted">{a.kind === 'cash' ? t('simple.home.cashInHand') : a.name}</span>
                    <span className={`num ${a.balance < 0 ? 'text-cr' : 'text-ink'}`}>{money(a.balance)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Tile>
        <Tile
          id="receivables"
          title={t('simple.home.customersOwe')}
          paise={home.receivables.total}
          why={receivablesWhy(home.receivables, t)}
          link={links.receivables}
        />
        <Tile
          id="payables"
          title={t('simple.home.youOweSuppliers')}
          paise={home.payables.total}
          why={payablesWhy(home.payables, home.today, t)}
          link={links.payables}
        />
        {gstRegular && (
          <Tile
            id="gst"
            title={t('simple.home.gstTitle')}
            value={gstLine(gstRegular, home.today, t)}
            paise={gstRegular.row.payable}
            why={gstWhy(gstRegular, home.today, t)}
            link={links.gst}
          >
            {gstRegular.filing === 'quarterly' && (
              <p className="mt-2 text-hint text-muted" data-testid="simple-home-gst-quarterly">
                {t('simple.home.gstQuarterly')}
              </p>
            )}
          </Tile>
        )}
        {home.gst?.kind === 'composition' && (
          <li className={cardCls} data-testid="simple-tile-gst-composition">
            <h2 className="text-small font-medium text-muted">{t('simple.home.gstTitle')}</h2>
            <p className="mt-2 text-detail text-ink">{t('simple.home.gstComposition')}</p>
          </li>
        )}
        <li className={`${cardCls} md:col-span-2 xl:col-span-1`} data-testid="simple-tile-profit" data-paise={home.profit.year.netProfit} data-month-paise={home.profit.month.netProfit}>
          <h2 className="text-small font-medium text-muted">{t('simple.home.profitTitle')}</h2>
          <p className="mt-2 text-lead text-ink" data-testid="simple-tile-profit-sentence">
            {profitSentence(home.profit, t)}
          </p>
          <div className="mt-2">
            <Why
              label={t('common.why')}
              ariaLabel={t('simple.home.whyLabel', { what: t('simple.home.profitTitle') })}
              sentence={homeProfitWhy(home.profit, t)}
              link={links.profit}
              testId="simple-why-profit"
            >
              <p className="text-small text-muted" data-testid="simple-why-profit-compare">
                {monthCompareWhy(home.profit, t)}
              </p>
            </Why>
          </div>
        </li>
      </ul>
      )}

      {!empty && <Attention home={home} />}

      {(home.deadlines.length > 0 || home.backup.nudge) && (
        <section className={`${cardCls} mt-5`} data-testid="simple-home-coming-up">
          <h2 className="text-title font-semibold text-ink">{t('simple.home.deadlinesTitle')}</h2>
          <ul className="mt-2 flex flex-col gap-1">
            {home.deadlines.map((d) => {
              const target = deadlineScreen(d.kind)
              return (
                <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-x-3 text-detail text-ink">
                  <span data-testid={`simple-deadline-${d.kind}`}>{deadlineText(d, home.today, t)}</span>
                  <Why
                    label={t('common.why')}
                    ariaLabel={t('simple.home.whyLabel', { what: deadlineText(d, home.today, t) })}
                    sentence={deadlineWhy(d, home.today, t)}
                    link={target ? { label: d.kind === 'tds' ? t('simple.why.link.tds') : t('simple.why.link.payroll'), onOpen: () => nav.go(target) } : undefined}
                    testId={`simple-why-deadline-${d.kind}`}
                  />
                </li>
              )
            })}
          </ul>
          {home.backup.nudge && home.backup.days != null && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md bg-panel2 px-3 py-2" data-testid="simple-home-backup-nudge">
              <p className="text-detail text-ink">{t('simple.home.backupNudge', { days: home.backup.days })}</p>
              <Button size="sm" variant="secondary" onClick={() => nav.go(backupsScreen)}>
                {t('simple.home.backupNow')}
              </Button>
            </div>
          )}
        </section>
      )}

      <Setup checklist={checklist} />
    </>
  )
}

function Tile({
  id,
  title,
  paise,
  value,
  why,
  link,
  children
}: {
  id: string
  title: string
  paise: number
  /** Shown instead of the amount (the GST tile's "₹Z by 20 Nov"). */
  value?: string
  why: string
  link: { label: string; onOpen: () => void }
  children?: ReactNode
}): React.JSX.Element {
  const t = useT()
  return (
    <li className={cardCls} data-testid={`simple-tile-${id}`} data-paise={paise}>
      <h2 className="text-small font-medium text-muted">{title}</h2>
      <p className={`num mt-1 text-heading font-semibold ${paise < 0 ? 'text-cr' : 'text-ink'}`} data-testid={`simple-tile-${id}-value`}>
        {value ?? money(paise)}
      </p>
      {children}
      <div className="mt-2">
        <Why
          label={t('common.why')}
          ariaLabel={t('simple.home.whyLabel', { what: title })}
          sentence={why}
          link={link}
          testId={`simple-why-${id}`}
        />
      </div>
    </li>
  )
}

function Attention({ home }: { home: SimpleHomeData }): React.JSX.Element | null {
  const t = useT()
  const nav = useNav()
  // The slow half (close checklist + anomaly scan) comes after Home shows; the overdue rows are
  // the tiles' own figures, so they show at once and never contradict them.
  const attentionQ = useQuery({
    queryKey: ['simple', 'homeAttention', home.today], // i18n-technical
    queryFn: () => api.simple.homeAttention(home.today)
  })
  const attention = attentionQ.data
  const period = attention?.period ?? ''
  const items = homeAttentionRows(owedAttention(home.receivables, home.payables), attention?.items ?? [])
  if (items.length === 0) return null
  return (
    <section className={`${cardCls} mt-5 border-amber/50`} data-testid="simple-home-attention" data-loading={attentionQ.isLoading ? 'true' : 'false'}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-title font-semibold text-ink">{t('simple.home.needsAttention')}</h2>
        <span className="text-small text-muted" data-testid="simple-home-attention-count">
          {attentionQ.isLoading ? t('simple.home.attentionLoading') : t('simple.home.attentionCount', { count: items.length })}
        </span>
      </div>
      <ul className="mt-2 flex flex-col">
        {items.slice(0, 3).map((item) => (
          <li key={`${item.source}-${item.key}`} className="border-b border-line/50 last:border-b-0">
            <button
              type="button"
              data-testid={`simple-attention-${item.source}-${item.key}`}
              onClick={() => nav.go(attentionScreen(item, period))}
              className="flex w-full items-start justify-between gap-3 py-2 text-left hover:bg-panel2 focus-visible:bg-panel2"
            >
              <span className="flex min-w-0 items-start gap-2">
                <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.level === 'high' ? 'bg-cr' : 'bg-amber'}`} />
                <span className="text-detail text-ink">{attentionText(item, period, t)}</span>
              </span>
              <span className="shrink-0 text-hint text-blue">{t('simple.home.attentionOpen')} →</span>
            </button>
          </li>
        ))}
      </ul>
      {items.length > 3 && (
        <button type="button" data-testid="simple-home-attention-all" className="mt-2 text-hint text-blue hover:underline" onClick={() => nav.go(attentionScreen(items[3]!, period))}>
          {t('simple.home.attentionSeeAll', { count: items.length })}
        </button>
      )}
      {attention?.anomaliesSkipped && (
        <p className="mt-2 text-hint text-muted" data-testid="simple-home-attention-capped">
          {t('simple.home.attentionCapped')}
        </p>
      )}
    </section>
  )
}

/** A company with nothing recorded: one card, with the next setup step as the way in. A
 *  continuing business that has not entered its day-one figures yet sees only the openings card
 *  (WP 8.7, above) — that is its first step, never offered twice. */
function EmptyHome({ checklist }: { checklist: OnboardingChecklist }): React.JSX.Element | null {
  const t = useT()
  const nav = useNav()
  const next = checklist.steps.find((s) => !s.done && STEP_LABEL[s.id])
  // Same query (and cache) as OpeningsHomeCard.
  const { data: openings } = useQuery({ queryKey: ['openings'], queryFn: api.openings.get }) // i18n-technical
  if (openings && !openings.appliedAt && openings.startedFresh === false) return null
  return (
    <section className={`${cardCls} mt-5`} data-testid="simple-home-empty">
      <h2 className="text-title font-semibold text-ink">{t('simple.home.emptyTitle')}</h2>
      <p className="mt-1 text-detail text-muted">{t('simple.home.emptyBody')}</p>
      <Button
        className="mt-4"
        variant="primary"
        data-testid="simple-home-empty-next"
        onClick={() => nav.go(next ? onboardingScreen(checklist, next.id) : HOME_TASKS[0]!.screen)}
      >
        {next ? t(STEP_LABEL[next.id]!.label) /* i18n-technical: keyed by step id */ : t(HOME_TASKS[0]!.label) /* i18n-technical: keyed in homeTasks.ts */}
      </Button>
    </section>
  )
}

function Setup({ checklist: all }: { checklist: OnboardingChecklist }): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  // A step that does not apply (the GST number for an unregistered business) is left out — never
  // shown ticked as if the user had done it. The step logic stays in onboarding.ts.
  const steps = all.steps.filter((s) => !s.skipped)
  const doneCount = steps.filter((s) => s.done).length
  const checklist = { ...all, steps, doneCount, total: steps.length, complete: doneCount === steps.length }
  return (
    <section data-testid="simple-home-setup" className={`${cardCls} mt-5`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-title font-semibold text-ink">{t('simple.home.setupTitle')}</h2>
        <span className="num text-small text-muted" data-testid="simple-home-setup-progress">
          {t('simple.home.setupProgress', { done: checklist.doneCount, total: checklist.total })}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={t('simple.home.setupTitle')}
        aria-valuemin={0}
        aria-valuemax={checklist.total}
        aria-valuenow={checklist.doneCount}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel2"
      >
        <div className="h-full rounded-full bg-amberbar" style={{ width: `${checklist.total ? Math.round((checklist.doneCount / checklist.total) * 100) : 100}%` }} />
      </div>
      {checklist.complete ? (
        <p className="mt-3 text-detail text-muted">{t('simple.home.setupDone')}</p>
      ) : (
        <ul className="mt-2 grid grid-cols-1 md:grid-cols-2">
          {checklist.steps.map((step) => {
            const keys = STEP_LABEL[step.id]
            if (!keys) return null
            const label = t(keys.label) // i18n-technical: keyed by step id above
            const hint = t(keys.hint) // i18n-technical: keyed by step id above
            const body = (
              <>
                <span
                  aria-hidden="true"
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-micro ${
                    step.done ? 'border-success bg-success-soft text-success' : 'border-line-strong text-transparent'
                  }`}
                >
                  ✓
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-detail ${step.done ? 'text-muted line-through decoration-line-strong' : 'text-ink'}`}>
                    {label}
                    <span className="sr-only"> {step.done ? t('simple.home.stepDone') : t('simple.home.stepToDo')}</span>
                  </span>
                  {!step.done && <span className="block text-hint text-muted">{hint}</span>}
                </span>
              </>
            )
            return (
              <li key={step.id} className="min-w-0">
                {step.done ? (
                  <div className="flex items-start gap-3 border-b border-line/50 px-4 py-2" data-testid={`simple-setup-${step.id}`} data-done="true">
                    {body}
                  </div>
                ) : (
                  <button
                    type="button"
                    data-testid={`simple-setup-${step.id}`}
                    data-done="false"
                    onClick={() => nav.go(onboardingScreen(checklist, step.id))}
                    className="flex w-full items-start gap-3 border-b border-line/50 px-4 py-2 text-left hover:bg-panel2 focus-visible:bg-panel2"
                  >
                    {body}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
