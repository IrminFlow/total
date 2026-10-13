import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, IpcError } from '../lib/client'
import { useT } from '../lib/i18n'
import { useNav, type Screen } from '../state/stores'
import { Banner, Button, Page } from '../components/ui'
import { formatPaise, formatQtyMilli } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import { ERROR_MAP, isErrorCode } from '@shared/errors'
import {
  OTHER_KIND_SIDE,
  differenceKind,
  draftFromState,
  openingSteps,
  openingsPayload,
  openingsStepErrors,
  stockLineValue,
  type OpeningStep,
  type OpeningsDraft,
  type OpeningsErrors,
  type OpeningsResult,
  type OpeningsState,
  type SimpleOpeningsInput
} from '@shared/simple/openings'
import type { MessageKey } from '@shared/i18n'
import { MoneyStep, OpeningsErrorsContext, OtherBalances, PartiesStep, StockStep, Question } from './OpeningsSteps'

/**
 * WP 8.7 (plan 2026-10-13 §3): "What you had on day one" — the opening setup for a business that
 * was already running. Money, what customers owe (bill by bill), what you owe suppliers, stock
 * (while stock is on), then Check and confirm: the difference is shown in one sentence and goes
 * to the owner's money (capital) only when the user confirms that very figure. The answers start
 * from the books' figures (`simple:openings:get`), so coming back shows what is there and a
 * re-run replaces only what is unchanged since (services/openings.ts).
 */
export function Openings(): React.JSX.Element {
  const t = useT()
  const { data: state } = useQuery({ queryKey: OPENINGS_KEY, queryFn: api.openings.get })
  if (!state) {
    return (
      <Page width="narrow">
        <p className="text-small text-muted" data-testid="openings-loading">
          {t('simple.openings.loading')}
        </p>
      </Page>
    )
  }
  return <OpeningsFlow state={state} />
}

const rupees = (paise: number): string => formatPaise(paise, { symbol: true })
const HOME: Screen = { name: 'gateway' } // i18n-technical
// The accountant view of openings: the accounts list with its Opening column.
const FULL_APP: Screen = { name: 'masters', tab: 'ledgers' } // i18n-technical
const CUSTOMERS = 'customers' as const // i18n-technical
const SUPPLIERS = 'suppliers' as const // i18n-technical

/** The confirm step's lines, from the answers (paise). */
function breakdown(p: SimpleOpeningsInput): {
  money: number
  customers: number
  stock: number
  otherHave: number
  suppliers: number
  otherOwe: number
} {
  const bills = (list: SimpleOpeningsInput['customers']): number => (list ?? []).reduce((s, r) => s + r.bills.reduce((x, b) => x + b.amount, 0), 0)
  let otherHave = 0
  let otherOwe = 0
  for (const o of p.others ?? []) {
    if (OTHER_KIND_SIDE[o.kind] > 0) otherHave += o.amount
    else otherOwe += o.amount
  }
  return {
    money: p.cash.amount + (p.banks ?? []).reduce((s, b) => s + b.amount, 0),
    customers: bills(p.customers),
    stock: (p.items ?? []).reduce((s, i) => s + (i.value ?? stockLineValue(i.qtyMilli, i.ratePaise)), 0),
    otherHave,
    suppliers: bills(p.suppliers),
    otherOwe
  }
}

/** The step a server field path belongs to ('customers.0.name' → customers). */
const STEP_OF_FIELD: Record<string, OpeningStep> = {
  cash: 'money', // i18n-technical
  banks: 'money', // i18n-technical
  customers: 'customers', // i18n-technical
  suppliers: 'suppliers', // i18n-technical
  items: 'stock' // i18n-technical
}
const CONFIRM: OpeningStep = 'confirm' // i18n-technical
const OPENINGS_KEY = ['openings'] // i18n-technical

function stepOfField(field: string, steps: OpeningStep[]): OpeningStep {
  const step = STEP_OF_FIELD[field.split('.')[0] ?? ''] ?? CONFIRM
  return steps.includes(step) ? step : CONFIRM
}

function OpeningsFlow({ state }: { state: OpeningsState }): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const queryClient = useQueryClient()
  const steps = useMemo(() => openingSteps(state.stockOn), [state.stockOn])
  const [draft, setDraft] = useState<OpeningsDraft>(() => draftFromState(state, formatQtyMilli))
  const [stepIdx, setStepIdx] = useState(0)
  const [errors, setErrors] = useState<OpeningsErrors>({})
  const [serverError, setServerError] = useState<{
    field: string | null
    key: MessageKey
    detail: string
  } | null>(null)
  const [preview, setPreview] = useState<OpeningsResult | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [more, setMore] = useState(state.others.length > 0)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<OpeningsResult | null>(null)
  const step = steps[stepIdx]!
  const last = step === 'confirm'
  const date = toPlainDate(state.booksBegin)
  const payload = useMemo(() => openingsPayload(draft), [draft])
  const payloadKey = JSON.stringify(payload)

  const update = (fn: (d: OpeningsDraft) => OpeningsDraft): void => {
    setDraft(fn)
    // A message goes as soon as the user changes something on the form.
    setErrors({})
    setServerError(null)
  }

  const explain = (err: unknown): { field: string | null; key: MessageKey; detail: string } => {
    const e = err instanceof IpcError ? err : null
    const key: MessageKey = e?.code && isErrorCode(e.code) ? ERROR_MAP[e.code].key : 'errors.couldNotSave'
    return { field: e?.field ?? null, key, detail: (err as Error).message }
  }

  // The confirm step's figures: the run rehearsed on the server (nothing written).
  useEffect(() => {
    if (!last || done) return
    let live = true
    setPreviewing(true)
    const timer = setTimeout(() => {
      api.openings
        .preview(payload)
        .then((r) => live && setPreview(r))
        .catch((err: unknown) => {
          if (!live) return
          setPreview(null)
          const x = explain(err)
          setServerError(x)
          if (x.field) setStepIdx(steps.indexOf(stepOfField(x.field, steps)))
        })
        .finally(() => live && setPreviewing(false))
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last, payloadKey, done])

  const next = (): void => {
    const e = openingsStepErrors(draft, step, state.booksBegin)
    setErrors(e)
    if (Object.keys(e).length) return
    setServerError(null)
    setStepIdx((i) => Math.min(i + 1, steps.length - 1))
  }

  const back = (): void => {
    setErrors({})
    setServerError(null)
    setStepIdx((i) => Math.max(i - 1, 0))
  }

  const confirm = async (): Promise<void> => {
    const e = openingsStepErrors(draft, 'confirm', state.booksBegin) // i18n-technical
    setErrors(e)
    if (Object.keys(e).length) {
      const first = Object.keys(e)[0]!
      setStepIdx(steps.indexOf(stepOfField(first, steps)))
      return
    }
    if (!preview) return
    setBusy(true)
    try {
      const r = await api.openings.apply({
        ...payload,
        confirmCapital: preview.capital.after
      })
      setDone(r)
      await queryClient.invalidateQueries()
    } catch (err) {
      const x = explain(err)
      setServerError(x)
      if (x.field) setStepIdx(steps.indexOf(stepOfField(x.field, steps)))
      // The figures moved under us: show the new ones.
      if (err instanceof IpcError && err.code === 'openings_changed') setPreview(await api.openings.preview(payload).catch(() => null))
    } finally {
      setBusy(false)
    }
  }

  if (done) return <OpeningsDone result={done} date={date} onHome={() => nav.go(HOME)} onFullApp={() => nav.go(FULL_APP)} />

  const props = { draft, update, state }
  const shown: OpeningsErrors = serverError?.field
    ? {
        ...errors,
        [serverError.field]: serverError.key as OpeningsErrors[string]
      }
    : errors
  const empty =
    payload.cash.amount === 0 &&
    !payload.banks?.length &&
    !payload.customers?.length &&
    !payload.suppliers?.length &&
    !payload.items?.length &&
    !payload.others?.length

  return (
    <Page width="narrow">
      <div data-testid="openings" data-step={step}>
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.openings.title')}</h1>
            <p className="mt-1 text-small text-muted">{t('simple.openings.intro', { date })}</p>
          </div>
          <button
            type="button"
            className="shrink-0 pt-2 text-small text-muted underline-offset-2 hover:text-ink hover:underline"
            data-testid="openings-full-app"
            onClick={() => nav.go(FULL_APP)}
          >
            {t('simple.openings.fullApp')}
          </button>
        </div>

        {state.startedFresh === true && !state.appliedAt && (
          <Banner className="mb-4" testId="openings-fresh-note">
            {t('simple.openings.freshNote', { date })}
          </Banner>
        )}

        <div className="rounded-xl border border-line bg-panel px-6 py-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase" data-testid="openings-step-label">
              {t('simple.openings.step', {
                step: stepIdx + 1,
                total: steps.length
              })}
            </p>
            <div className="flex gap-1" aria-hidden="true">
              {steps.map((s, i) => (
                <span key={s} className={`h-1.5 w-6 rounded-full ${i <= stepIdx ? 'bg-amber' : 'bg-line'}`} />
              ))}
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (last) void confirm()
              else next()
            }}
          >
            <OpeningsErrorsContext.Provider value={shown}>
              {step === 'money' && <MoneyStep {...props} />}
              {step === 'customers' && <PartiesStep {...props} side={CUSTOMERS} />}
              {step === 'suppliers' && <PartiesStep {...props} side={SUPPLIERS} />}
              {step === 'stock' && <StockStep {...props} />}
              {step === 'confirm' && (
                <ConfirmStep
                  {...props}
                  payload={payload}
                  preview={preview}
                  previewing={previewing}
                  more={more}
                  onMore={() => setMore((m) => !m)}
                  empty={empty}
                />
              )}
            </OpeningsErrorsContext.Provider>

            {serverError && !serverError.field && (
              <p role="alert" className="mt-4 rounded-md border border-danger/50 px-3 py-2 text-small text-danger" data-testid="openings-failure">
                {t(serverError.key)} {/* i18n-technical: errors.* key from ERROR_MAP */}
                <span className="sr-only">{serverError.detail}</span>
              </p>
            )}

            <div className="mt-6 flex items-center justify-between">
              {stepIdx > 0 ? (
                <Button type="button" variant="ghost" data-testid="openings-back" onClick={back} disabled={busy}>
                  {t('common.back')}
                </Button>
              ) : (
                <span />
              )}
              {last ? (
                <Button type="submit" variant="primary" data-testid="openings-confirm" disabled={busy || previewing || !preview || empty}>
                  {busy ? t('simple.openings.saving') : t('simple.openings.confirm.button')}
                </Button>
              ) : (
                <Button type="submit" variant="primary" data-testid="openings-next">
                  {t('common.next')}
                </Button>
              )}
            </div>
          </form>
        </div>
      </div>
    </Page>
  )
}

function Line({ label, amount, testId, strong = false }: { label: string; amount: number; testId: string; strong?: boolean }): React.JSX.Element {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-1.5 ${strong ? 'border-t border-line font-semibold text-ink' : 'text-ink'}`}>
      <span className={strong ? '' : 'text-muted'}>{label}</span>
      <span className="num" data-testid={testId}>
        {rupees(amount)}
      </span>
    </div>
  )
}

function ConfirmStep({
  payload,
  preview,
  previewing,
  more,
  onMore,
  empty,
  ...props
}: Parameters<typeof OtherBalances>[0] & {
  payload: SimpleOpeningsInput
  preview: OpeningsResult | null
  previewing: boolean
  more: boolean
  onMore: () => void
  empty: boolean
}): React.JSX.Element {
  const t = useT()
  const date = toPlainDate(props.state.booksBegin)
  const b = breakdown(payload)
  const answersHave = b.money + b.customers + b.stock + b.otherHave
  const answersOwe = b.suppliers + b.otherOwe
  const kind = preview ? differenceKind(preview.difference) : null
  return (
    <div data-testid="openings-step-confirm">
      <Question title={t('simple.openings.confirm.title')} hint={t('simple.openings.confirm.hint', { date })} />

      <div className="mb-4">
        <Button type="button" variant="ghost" data-testid="openings-more" aria-expanded={more} onClick={onMore}>
          {more ? t('simple.openings.moreHide') : t('simple.openings.more')}
        </Button>
        {more && (
          <div className="mt-2">
            <OtherBalances {...props} />
          </div>
        )}
      </div>

      {empty ? (
        <p className="text-body text-muted" data-testid="openings-nothing">
          {t('simple.openings.confirm.nothing')}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
            <div>
              <Line label={t('simple.openings.confirm.money')} amount={b.money} testId="openings-sum-money" />
              <Line label={t('simple.openings.confirm.customers')} amount={b.customers} testId="openings-sum-customers" />
              {props.state.stockOn && <Line label={t('simple.openings.confirm.stock')} amount={b.stock} testId="openings-sum-stock" />}
              {b.otherHave > 0 && <Line label={t('simple.openings.confirm.otherHave')} amount={b.otherHave} testId="openings-sum-other-have" />}
              <Line label={t('simple.openings.confirm.have')} amount={preview?.have ?? answersHave} testId="openings-sum-have" strong />
            </div>
            <div>
              <Line label={t('simple.openings.confirm.suppliers')} amount={b.suppliers} testId="openings-sum-suppliers" />
              {b.otherOwe > 0 && <Line label={t('simple.openings.confirm.otherOwe')} amount={b.otherOwe} testId="openings-sum-other-owe" />}
              <Line label={t('simple.openings.confirm.owe')} amount={preview?.owe ?? answersOwe} testId="openings-sum-owe" strong />
            </div>
          </div>

          <div className="mt-5 rounded-lg border border-amber/60 bg-amberbar/10 px-4 py-3" data-testid="openings-difference" aria-live="polite">
            {!preview || previewing ? (
              <p className="text-body text-muted">{t('simple.openings.checking')}</p>
            ) : (
              <>
                <p className="text-body font-semibold text-ink" data-testid="openings-difference-sentence" data-kind={kind ?? ''}>
                  {kind === 'more' &&
                    t('simple.openings.confirm.more', {
                      amount: rupees(preview.difference)
                    })}
                  {kind === 'less' &&
                    t('simple.openings.confirm.less', {
                      amount: rupees(-preview.difference)
                    })}
                  {kind === 'even' && t('simple.openings.confirm.even')}
                </p>
                {(preview.have !== answersHave || preview.owe !== answersOwe) && (
                  <p className="mt-1 text-small text-muted">{t('simple.openings.confirm.alsoCounted')}</p>
                )}
                {preview.capital.before !== 0 && preview.capital.before !== preview.capital.after && (
                  <p className="mt-1 text-small text-muted" data-testid="openings-capital-was">
                    {t('simple.openings.confirm.capitalWas', {
                      before: rupees(-preview.capital.before),
                      after: rupees(-preview.capital.after)
                    })}
                  </p>
                )}
              </>
            )}
          </div>
          {preview && preview.warnings.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1" data-testid="openings-warnings">
              {preview.warnings.map((w) => (
                <li key={`${w.kind}-${w.name}`} className="text-small text-warning">
                  {t('simple.openings.confirm.kept', {
                    name: w.name,
                    amount: rupees(Math.abs(w.kept))
                  })}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

function OpeningsDone({
  result,
  date,
  onHome,
  onFullApp
}: {
  result: OpeningsResult
  date: string
  onHome: () => void
  onFullApp: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <Page width="narrow">
      <div className="rounded-xl border border-line bg-panel px-6 py-5" data-testid="openings-done">
        <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.openings.done.title')}</h1>
        <p className="mt-2 text-body text-ink">{result.changed === 0 ? t('simple.openings.done.unchanged') : t('simple.openings.done.body', { date })}</p>
        {result.warnings.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1">
            {result.warnings.map((w) => (
              <li key={`${w.kind}-${w.name}`} className="text-small text-warning">
                {t('simple.openings.confirm.kept', {
                  name: w.name,
                  amount: rupees(Math.abs(w.kept))
                })}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="primary" data-testid="openings-done-home" onClick={onHome}>
            {t('simple.openings.done.home')}
          </Button>
          <Button variant="ghost" data-testid="openings-done-full-app" onClick={onFullApp}>
            {t('simple.openings.fullApp')}
          </Button>
        </div>
      </div>
    </Page>
  )
}
