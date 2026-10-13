import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { onboardingScreen } from '../lib/onboarding'
import { useNav, useSession } from '../state/stores'
import { Page } from '../components/ui'
import { OpeningsHomeCard } from './OpeningsHomeCard'
import { onboardingFromDashSetup, type OnboardingStepId } from '@shared/onboarding'
import { todayISO } from '@shared/dates'
import type { MessageKey } from '@shared/i18n'

/** Plain labels for the onboarding steps, keyed by step id (the step logic stays in onboarding.ts). */
const STEP_LABEL: Record<OnboardingStepId, { label: MessageKey; hint: MessageKey }> = {
  company: { label: 'simple.setupSteps.company.label', hint: 'simple.setupSteps.company.hint' },
  gstin: { label: 'simple.setupSteps.gstin.label', hint: 'simple.setupSteps.gstin.hint' },
  ledger: { label: 'simple.setupSteps.ledger.label', hint: 'simple.setupSteps.ledger.hint' },
  bank: { label: 'simple.setupSteps.bank.label', hint: 'simple.setupSteps.bank.hint' },
  voucher: { label: 'simple.setupSteps.voucher.label', hint: 'simple.setupSteps.voucher.hint' },
  invoice: { label: 'simple.setupSteps.invoice.label', hint: 'simple.setupSteps.invoice.hint' },
  backup: { label: 'simple.setupSteps.backup.label', hint: 'simple.setupSteps.backup.hint' }
}

/**
 * WP 8.1: the simple Home — a plain placeholder card (the tiles and task buttons are WP 8.6) and
 * the setup checklist, from the same dashboard `setup` facts the accountant Gateway uses.
 */
export function SimpleHome(): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const from = useSession((s) => s.from)
  const to = useSession((s) => s.to)
  const today = todayISO()
  // Same query (and cache) as the accountant Gateway's setup card.
  const seriesQ = useQuery({
    queryKey: ['dashboard', 'series', today, from, to], // i18n-technical
    queryFn: () => api.reports.dashboardSeries(today, from, to)
  })
  const setup = seriesQ.data?.setup.ok ? seriesQ.data.setup.data : null
  const checklist = setup ? onboardingFromDashSetup(setup) : null

  return (
    <Page data-testid="simple-home">
      <h1 className="mb-5 font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.home.title')}</h1>
      <section data-testid="simple-home-coming" className="rounded-lg border border-line bg-panel p-panel shadow-elev-1">
        <h2 className="text-title font-semibold text-ink">{t('simple.home.comingTitle')}</h2>
        <p className="mt-2 text-detail text-muted">{t('simple.home.comingBody')}</p>
      </section>

      <OpeningsHomeCard series={seriesQ.data} />

      {checklist && (
        <section data-testid="simple-home-setup" className="mt-5 rounded-lg border border-line bg-panel p-panel shadow-elev-1">
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
                const label = t(keys.label) // i18n-technical: keyed by step id above
                const hint = step.skipped ? t('simple.setupSteps.gstin.notNeeded') : t(keys.hint) // i18n-technical: keyed by step id above
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
                      {(!step.done || step.skipped) && <span className="block text-hint text-muted">{hint}</span>}
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
      )}
    </Page>
  )
}
