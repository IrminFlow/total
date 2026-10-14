import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { useNav, useToasts } from '../state/stores'
import { Button } from '../components/ui'
import { formatPaise } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import type { Screen } from '../state/stores'

export const OPENINGS_FROM_HOME: Screen = { name: 'simple-openings', from: 'home' } // i18n-technical

/**
 * WP 8.7: Home's setup step "Enter what you had on day one" for a business that was already
 * running (setup's "continuing" answer, meta ui.startedFresh = false), with how many parts hold a
 * figure; "I started fresh" skips it. Once the figures are confirmed it says what customers owe
 * and what you owe suppliers — `owed`, the simple Home's own tiles (simple:home, the Outstandings
 * allocation as on today, which reads opening bills through services/openingBills.ts). Not shown
 * for a fresh start or a company setup never asked (accountant companies switched to simple).
 */
export function OpeningsHomeCard({ owed }: { owed: { receivables: number; payables: number } | null | undefined }): React.JSX.Element | null {
  const t = useT()
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: state } = useQuery({ queryKey: ['openings'], queryFn: api.openings.get }) // i18n-technical
  const [busy, setBusy] = useState(false)
  if (!state) return null
  if (!state.appliedAt && state.startedFresh !== false) return null
  const open = (): void => nav.go(OPENINGS_FROM_HOME)
  const date = toPlainDate(state.booksBegin, t.lang)

  if (state.appliedAt) {
    const owedToYou = owed?.receivables ?? null
    const owe = owed?.payables ?? null
    return (
      <section data-testid="simple-home-openings" data-done="true" className="mt-5 rounded-lg border border-line bg-panel p-panel shadow-elev-1">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-title font-semibold text-ink">
            <span aria-hidden="true" className="mr-2 text-success">
              ✓
            </span>
            {t('simple.openings.home.doneTitle')}
          </h2>
          <button type="button" data-testid="simple-home-openings-change" onClick={open} className="text-small text-muted underline-offset-2 hover:text-ink hover:underline">
            {t('simple.openings.home.change')}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-8 gap-y-1 text-body text-ink">
          {owedToYou != null && <p data-testid="simple-home-customers-owe">{t('simple.openings.home.customersOwe', { amount: formatPaise(owedToYou, { symbol: true }) })}</p>}
          {owe != null && <p data-testid="simple-home-you-owe">{t('simple.openings.home.youOwe', { amount: formatPaise(owe, { symbol: true }) })}</p>}
        </div>
      </section>
    )
  }

  const fresh = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.openings.skip()
      await queryClient.invalidateQueries({ queryKey: ['openings'] }) // i18n-technical
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const { done, total } = state.progress
  return (
    <section data-testid="simple-home-openings" data-done="false" className="mt-5 rounded-lg border border-amber/60 bg-panel p-panel shadow-elev-1">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-title font-semibold text-ink">{t('simple.openings.home.title')}</h2>
        <span className="num text-small text-muted" data-testid="simple-home-openings-progress">
          {t('simple.openings.home.progress', { done, total })}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={t('simple.openings.home.title')}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel2"
      >
        <div className="h-full rounded-full bg-amberbar" style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
      </div>
      <p className="mt-3 text-detail text-muted">{t('simple.openings.home.hint', { date })}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="primary" data-testid="simple-home-openings-start" onClick={open}>
          {done > 0 ? t('simple.openings.home.continue') : t('simple.openings.home.start')}
        </Button>
        <Button variant="ghost" data-testid="simple-home-openings-fresh" disabled={busy} onClick={() => void fresh()} title={t('simple.openings.home.freshHint')}>
          {t('simple.openings.home.fresh')}
        </Button>
      </div>
    </section>
  )
}
