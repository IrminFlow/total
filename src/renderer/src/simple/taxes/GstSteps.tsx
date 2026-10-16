import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { gstPeriodOf, toMonthLabel, toPlainDate } from '@shared/dates'
import { mapError, type CaughtError } from '@shared/errors'
import { gstPeriodEnd, quarterStart, stepsDone, type GstForm, type MissingBillsItem, type SimpleTaxes } from '@shared/simple/taxes'
import type { HomeAttentionItem } from '@shared/simple/home'
import { attentionText, money } from '@shared/simple/explain'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useCapabilityRefused } from '../../lib/capabilities'
import { useNav, useToasts } from '../../state/stores'
import { Button } from '../../components/ui'
import { cardCls } from '../reports/parts'
import { FiledForm } from './FiledForm'

type Regular = Extract<SimpleTaxes, { kind: 'regular' }>
const closeScreen = (period: string): { name: 'assistants'; tab: 'close'; period: string } => ({ name: 'assistants', tab: 'close', period }) // i18n-technical
const gst2bScreen = (period: string): { name: 'assistants'; tab: 'gst2b'; period: string } => ({ name: 'assistants', tab: 'gst2b', period }) // i18n-technical
const IMPORT_2B = { name: 'gstr2b' } as const // i18n-technical
const GSTR1 = { name: 'gstr1' } as const // i18n-technical
const FORMS: readonly GstForm[] = ['gstr1', 'gstr3b']
/** An ISO timestamp as the local day, in plain words. */
const localDay = (at: string, lang?: string): string => {
  const d = new Date(at)
  return toPlainDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, lang)
}
/** A month-end check as Home's attention row (its plain sentence). */
const missingItem = (key: MissingBillsItem['key'], count: number): HomeAttentionItem => ({ source: 'close', key, count, amount: null, level: 'medium' }) // i18n-technical

function Step({ n, title, done, children, testId }: { n: number; title: string; done: boolean; children: ReactNode; testId: string }): React.JSX.Element {
  const t = useT()
  return (
    <li className="flex gap-3 border-t border-line py-3 first:border-t-0" data-testid={testId} data-done={done}>
      <span
        aria-hidden="true"
        className={`num mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-small font-semibold ${done ? 'bg-success text-panel' : 'border border-line bg-panel2 text-ink'}`}
      >
        {done ? '✓' : n}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-lead font-medium text-ink">
          {title}
          {done && <span className="sr-only"> · {t('simple.taxes.step.done')}</span>}
        </h3>
        <div className="mt-1 text-detail text-ink">{children}</div>
      </div>
    </li>
  )
}

/**
 * WP 9.9 — the five steps to file (plan §3 "GST answer"): 1 bills that may be missing (the
 * month-end checks, plain words), 2 supplier bills against GSTR-2B (the WP 5.5 mismatch list),
 * 3 prepare the files (the existing GSTR-1 / 3B exports, unchanged), 4 upload and pay on
 * gst.gov.in (the portal's own steps), 5 "I've filed" (ARN + date, meta gstFiled).
 */
export function GstSteps({ x }: { x: Regular }): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const done = stepsDone(x)
  const count = [done.missing, done.supplier, done.files, done.filed, done.filed].filter(Boolean).length
  const lastMonth = x.period.period
  return (
    <section className={`${cardCls} mt-4`} data-testid="taxes-steps">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-subtitle font-semibold text-ink">{t('simple.taxes.steps.title')}</h2>
        <span className="text-small text-muted" data-testid="taxes-steps-progress">
          {t('simple.taxes.steps.progress', { done: count, total: 5 })}
        </span>
      </div>
      <ol className="mt-2">
        <Step n={1} title={t('simple.taxes.gst.step1')} done={done.missing} testId="taxes-step-1">
          {x.missing.length === 0 ? (
            <p>{t('simple.taxes.step1.ok')}</p>
          ) : (
            <>
              <p className="text-muted">{t('simple.taxes.step1.hint')}</p>
              <ul className="mt-1 list-disc pl-5">
                {x.missing.map((m) => (
                  <li key={m.key} data-testid={`taxes-missing-${m.key}`}>
                    {attentionText(missingItem(m.key, m.count), lastMonth, t)}
                  </li>
                ))}
              </ul>
              <Button className="mt-2" size="sm" data-testid="taxes-step1-open" onClick={() => nav.go(closeScreen(lastMonth))}>
                {t('simple.taxes.step1.open')}
              </Button>
            </>
          )}
        </Step>

        <Step n={2} title={t('simple.taxes.gst.step2')} done={done.supplier} testId="taxes-step-2">
          <ul className="flex flex-col gap-1">
            {x.supplierBills.map((m) => {
              const month = toMonthLabel(m.month, 'long', t.lang) // i18n-technical
              const issues = m.categories.reduce((s, c) => s + c.count, 0)
              return (
                <li key={m.month} data-testid={`taxes-2b-${m.month}`} data-imported={m.imported}>
                  {!m.imported
                    ? t('simple.taxes.step2.notImported', { month })
                    : issues === 0
                      ? t('simple.taxes.step2.clean', { month, count: m.matched })
                      : t('simple.taxes.step2.issues', { month, count: issues })}
                  {m.categories.length > 0 && (
                    <ul className="mt-0.5 list-disc pl-5 text-small text-muted">
                      {m.categories.map((c) => (
                        <li key={c.category}>{t('simple.taxes.step2.cat', { category: c.category, count: c.count, amount: money(c.tax) })}</li>
                      ))}
                    </ul>
                  )}
                  {m.imported && issues > 0 && (
                    <Button className="mt-1" size="sm" data-testid={`taxes-2b-review-${m.month}`} onClick={() => nav.go(gst2bScreen(m.month))}>
                      {t('simple.taxes.step2.review')}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
          {x.supplierBills.some((m) => !m.imported) && (
            <Button className="mt-2" size="sm" data-testid="taxes-2b-import" onClick={() => nav.go(IMPORT_2B)}>
              {t('simple.taxes.step2.import')}
            </Button>
          )}
        </Step>

        <Step n={3} title={t('simple.taxes.gst.step3')} done={done.files} testId="taxes-step-3">
          <PrepareFiles x={x} />
        </Step>

        <Step n={4} title={t('simple.taxes.gst.step4')} done={done.filed} testId="taxes-step-4">
          <p className="text-muted">{t('simple.taxes.step4.intro')}</p>
          <ol className="mt-1 list-decimal pl-5">
            <li>{t('simple.taxes.step4.a', { filing: x.filing })}</li>
            <li>{t('simple.taxes.step4.b')}</li>
            <li>{t('simple.taxes.step4.c')}</li>
            <li>{t('simple.taxes.step4.d')}</li>
          </ol>
        </Step>

        <Step n={5} title={t('simple.taxes.gst.step5')} done={done.filed} testId="taxes-step-5">
          <p className="text-muted">{t('simple.taxes.step5.intro')}</p>
          {x.period.soFar ? (
            <p className="mt-1" data-testid="taxes-filed-not-over">
              {t('simple.taxes.step5.notOver')}
            </p>
          ) : (
            <div className="mt-2 flex flex-col gap-3">
              {FORMS.map((form) => (
                <FiledForm key={form} form={form} period={x.period.period} periodEnd={x.period.to} today={x.today} filed={x.filed[form] ?? null} />
              ))}
            </div>
          )}
        </Step>
      </ol>
    </section>
  )
}

/** Step 3: the existing GSTR-1 / GSTR-3B exports for the period, once it is over. A quarterly
 *  filer's quarter is prepared month by month (the full app's monthly exports, which GSTR-9
 *  compares) and the three months' files are put in one folder. */
function PrepareFiles({ x }: { x: Regular }): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const push = useToasts((s) => s.push)
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState<GstForm | null>(null)
  const [error, setError] = useState<{ text: string; details: string } | null>(null)
  const quarterly = x.period.quarterly
  const exportRefused = useCapabilityRefused('canExport') // i18n-technical
  if (x.period.soFar) return <p data-testid="taxes-files-wait">{t('simple.taxes.step3.wait', { date: toPlainDate(gstPeriodEnd(x.period), t.lang) })}</p>
  const prepare = async (form: GstForm): Promise<void> => {
    setBusy(form)
    setError(null)
    const args = [x.period.from, x.period.to, gstPeriodOf(`${x.period.period}-01`)] as const
    try {
      if (quarterly) await api.gst.exportQuarter(form, `${quarterStart(x.period.period)}-01`, gstPeriodEnd(x.period), args[2])
      else if (form === 'gstr1') await api.gst.exportGstr1(...args)
      else await api.gst.exportGstr3b(...args)
      push('success', quarterly ? t('simple.taxes.step3.savedQuarter') : t('simple.taxes.step3.saved'))
      void queryClient.invalidateQueries({ queryKey: ['simpleTaxes'] }) // i18n-technical
    } catch (err) {
      const m = mapError(err as CaughtError, { simple: true, t })
      setError({ text: t('errors.taxes.prepareFailed'), details: m.details })
    } finally {
      setBusy(null)
    }
  }
  const label = (form: GstForm): string =>
    quarterly
      ? form === 'gstr1' ? t('simple.taxes.step3.prepare1Quarter') : t('simple.taxes.step3.prepare3bQuarter')
      : form === 'gstr1' ? t('simple.taxes.step3.prepare1') : t('simple.taxes.step3.prepare3b')
  // #146: a sign-in the owner refused canExport can't save the files (main refuses them too).
  if (exportRefused) {
    return (
      <p className="text-detail text-muted" data-testid="taxes-export-refused">
        {t('simple.taxes.step3.exportRefused')}
      </p>
    )
  }
  return (
    <>
      {quarterly && (
        <p className="mb-2" data-testid="taxes-files-quarterly">
          {t('simple.taxes.step3.quarterly')}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {FORMS.map((form) => (
          <li key={form} className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant={!x.prepared[form] && FORMS.find((f) => !x.prepared[f]) === form ? 'primary' : 'secondary'} loading={busy === form} disabled={busy !== null} data-testid={`taxes-prepare-${form}`} onClick={() => void prepare(form)}>
              {label(form)}
            </Button>
            <span className="text-small text-muted" data-testid={`taxes-prepared-${form}`}>
              {x.prepared[form] ? t('simple.taxes.gst.prepared', { date: localDay(x.prepared[form]!, t.lang) }) : t('simple.taxes.step3.notYet')}
            </span>
          </li>
        ))}
      </ul>
      {error && (
        <div className="mt-2 rounded-md border border-danger/50 bg-danger-soft px-3 py-2" role="alert" data-testid="taxes-prepare-error">
          <p className="text-detail text-danger">{error.text}</p>
          <details className="mt-1 text-small text-muted">
            <summary className="cursor-pointer">{t('common.details')}</summary>
            {error.details}
          </details>
          <Button className="mt-2" size="sm" onClick={() => nav.go(GSTR1)}>
            {t('simple.taxes.step3.openFull')}
          </Button>
        </div>
      )}
    </>
  )
}
