import { useQuery } from '@tanstack/react-query'
import { toPlainDate } from '@shared/dates'
import type { SimpleTaxes } from '@shared/simple/taxes'
import { collectedWhy, compositionDueWhy, creditLeftWhy, creditStatus, dueWhy, onPurchasesWhy, shortDate, taxesPeriodLabel, toPayPartsWhy } from '@shared/simple/explain'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useNav, useSession } from '../../state/stores'
import { Page, Select, SkeletonTiles } from '../../components/ui'
import { FigureTile, LoadError, ReportHeader, WhyLink, cardCls, money } from '../reports/parts'
import { GstSteps } from './GstSteps'
import { EmptyTeach } from '../help/EmptyTeach'
import { WithholdingCards } from './Withholding'

type Regular = Extract<SimpleTaxes, { kind: 'regular' }>
const gstr3bScreen = (month: string): { name: 'gstr3b'; month: string } => ({ name: 'gstr3b', month }) // i18n-technical
const gstr1Screen = (month: string): { name: 'gstr1'; month: string } => ({ name: 'gstr1', month }) // i18n-technical
const CMP08 = 'cmp08' // i18n-technical
const GSTR4 = 'gstr4' // i18n-technical
const PMT06 = 'pmt06' // i18n-technical
const taxesScreen = (period: string): { name: 'simple-taxes'; period: string } => ({ name: 'simple-taxes', period }) // i18n-technical

/**
 * WP 9.9 — Taxes (plan §2.2, §3 "GST answer"): what you owe the government and by when.
 * Regular GST: the period (the Home tile's by default; a quarter for a quarterly filer), THREE
 * separate figures — GST you collected, GST on purchases (with what GSTR-2B has not confirmed),
 * cash to pay by the date — the dates, then the five steps to file. Unregistered: nothing to
 * file. Composition: the CMP-08 / GSTR-4 dates only. TDS / TCS when they apply. Every figure is
 * simple:taxes' (gstr3b() and the stored GSTR-2B); Total prepares, the user files.
 */
export function TaxesScreen({ period }: { period?: string }): React.JSX.Element {
  const t = useT()
  const today = useSession((s) => s.workingDate)
  const nav = useNav()
  const q = useQuery({ queryKey: ['simpleTaxes', period ?? null, today], queryFn: () => api.simpleTaxes.get(period, today) }) // i18n-technical
  const x = q.data
  const accountant = x?.kind === 'regular' ? { screen: gstr3bScreen(x.period.from.slice(0, 7)), hint: t('simple.taxes.accountant3b') } : undefined
  return (
    <Page data-testid="simple-taxes" data-kind={x?.kind}>
      <ReportHeader testId="taxes" title={t('simple.taxes.title')} subtitle={t('simple.taxes.subtitle')} accountant={accountant} />
      {q.isError && <LoadError testId="taxes" text={t('simple.taxes.loadError')} onRetry={() => void q.refetch()} />}
      {!x && !q.isError && <SkeletonTiles count={3} />}
      {x?.kind === 'unregistered' && (
        <EmptyTeach
          testId="taxes-unregistered"
          purpose={t('simple.taxes.gst.unregistered')}
          action={{ label: t('simple.empty.taxesBusiness'), testId: 'btn-taxes-business', onClick: () => nav.go({ name: 'company-info' }) }} // i18n-technical
          help="gst" // i18n-technical
        />
      )}
      {x?.kind === 'composition' && (
        <section className={cardCls} data-testid="taxes-composition">
          <h2 className="text-lead font-semibold text-ink">{t('simple.taxes.gst.compositionTitle')}</h2>
          <ul className="mt-2 flex flex-col gap-1 text-body text-ink">
            <li className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span data-testid="taxes-cmp08">{t('simple.taxes.composition.cmp08', { from: toPlainDate(x.composition.cmp08.from, t.lang), to: toPlainDate(x.composition.cmp08.to, t.lang), date: toPlainDate(x.composition.cmp08.due, t.lang) })}</span>
              <WhyLink what={t('simple.taxes.composition.cmp08', { from: toPlainDate(x.composition.cmp08.from, t.lang), to: toPlainDate(x.composition.cmp08.to, t.lang), date: toPlainDate(x.composition.cmp08.due, t.lang) })} sentence={compositionDueWhy(CMP08, x, t)} testId="why-due-cmp08" />
            </li>
            <li className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span data-testid="taxes-gstr4">{t('simple.taxes.composition.gstr4', { fy: x.composition.gstr4.fyLabel, date: toPlainDate(x.composition.gstr4.due, t.lang) })}</span>
              <WhyLink what={t('simple.taxes.composition.gstr4', { fy: x.composition.gstr4.fyLabel, date: toPlainDate(x.composition.gstr4.due, t.lang) })} sentence={compositionDueWhy(GSTR4, x, t)} testId="why-due-gstr4" />
            </li>
          </ul>
          <p className="mt-2 text-small text-muted">{t('simple.taxes.composition.note')}</p>
        </section>
      )}
      {x?.kind === 'regular' && <GstAnswer x={x} />}
      {x && <WithholdingCards items={x.withholding} today={x.today} />}
    </Page>
  )
}

function GstAnswer({ x }: { x: Regular }): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const f = x.figures
  const by = t('simple.taxes.gst.byDate', { date: shortDate(x.due.gstr3b, x.today, t.lang) })
  const link = { label: t('simple.taxes.accountant3b'), screen: gstr3bScreen(x.period.from.slice(0, 7)) }
  const dueLink = {
    gstr1: { label: t('simple.why.link.gstr1'), screen: gstr1Screen(x.period.from.slice(0, 7)) },
    gstr3b: { label: t('simple.why.link.gstr3b'), screen: gstr3bScreen(x.period.from.slice(0, 7)) }
  }
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-detail text-muted">
          {t('simple.taxes.periodLabel')}
          <Select data-testid="taxes-period" value={x.period.period} onChange={(e) => nav.replace(taxesScreen(e.target.value))}>
            {x.periods.map((p) => (
              <option key={p.period} value={p.period}>
                {taxesPeriodLabel(p, t)}
              </option>
            ))}
          </Select>
        </label>
        <span className="text-detail text-muted" data-testid="taxes-filing">
          {t('simple.taxes.filing', { filing: x.filing })}
        </span>
      </div>
      {f.collected === 0 && f.onPurchases === 0 && f.toPay === 0 && f.reverseCharge === 0 && (
        <div className="mb-4">
          <EmptyTeach
            testId="taxes-empty"
            purpose={t('simple.empty.taxesRegular')}
            action={{ label: t('simple.sales.makeBill'), testId: 'btn-taxes-empty-sell', onClick: () => nav.go({ name: 'simple-sell' }) }} // i18n-technical
            help="gst" // i18n-technical
          />
        </div>
      )}
      {x.period.soFar && (
        <p className="mb-3 text-detail text-muted" data-testid="taxes-so-far">
          {t('simple.taxes.gst.soFarNote', { date: toPlainDate(x.period.to, t.lang) })}
        </p>
      )}
      {x.running && (
        <p className="mb-3 text-detail text-ink" data-testid="taxes-running">
          {t('simple.taxes.runningSoFar', { period: taxesPeriodLabel(x.running.period, t), collected: money(x.running.collected), purchases: money(x.running.onPurchases) })}{' '}
          <button type="button" className="text-blue hover:underline" data-testid="btn-taxes-running" onClick={() => nav.replace(taxesScreen(x.running!.period.period))}>
            {t('simple.taxes.runningOpen')}
          </button>
        </p>
      )}
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-3" data-testid="taxes-figures">
        <FigureTile
          id="gst-collected"
          title={t('simple.taxes.gst.collectedLabel')}
          paise={f.collected}
          sub={f.reverseCharge > 0 ? t('simple.taxes.gst.rcmLine', { amount: money(f.reverseCharge) }) : null}
          why={collectedWhy(x, t)}
          link={link}
        />
        <FigureTile id="gst-purchases" title={t('simple.taxes.gst.onPurchasesLabel')} paise={f.onPurchases} sub={creditStatus(f, t)} why={onPurchasesWhy(x, t)} link={link} />
        <FigureTile id="gst-to-pay" emphasis title={t('simple.taxes.gst.toPayLabel')} paise={f.toPay} sub={by} why={toPayPartsWhy(x, t)} whyExtra={creditLeftWhy(f, t)} link={link} />
      </ul>

      <section className={`${cardCls} mt-4`} data-testid="taxes-dates">
        <h2 className="text-subtitle font-semibold text-ink">{t('simple.taxes.due.title')}</h2>
        <ul className="mt-2 flex flex-col gap-1 text-body text-ink">
          {(['gstr1', 'gstr3b'] as const).map((form) => { // i18n-technical
            const label = form === 'gstr1' ? t('simple.taxes.due.gstr1', { date: toPlainDate(x.due.gstr1, t.lang) }) : t('simple.taxes.due.gstr3b', { date: toPlainDate(x.due.gstr3b, t.lang) }) // i18n-technical
            return (
              <li key={form} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span data-testid={`taxes-due-${form}`}>
                  {label}
                  {/* Review fix: a date already gone by, for a return not noted as filed, says so. */}
                  {x.today > x.due[form] && !x.filed[form] && (
                    <span className="ml-2 font-medium text-warning" data-testid={`taxes-due-${form}-passed`}>
                      {t('simple.taxes.due.passed')}
                    </span>
                  )}
                </span>
                <WhyLink what={label} sentence={dueWhy(form, x, t)} link={dueLink[form]} testId={`why-due-${form}`} />
              </li>
              )
          })}
        </ul>
        {x.due.gstr3bUnverified && <p className="mt-1 text-small text-muted">{t('simple.taxes.due.unverified')}</p>}
        {x.due.pmt06.length > 0 && (
          <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3">
            <p className="text-small text-muted" data-testid="taxes-pmt06">
              {t('simple.taxes.due.pmt06', { dates: x.due.pmt06.map((d) => shortDate(d, x.today, t.lang)).join(', ') })}
            </p>
            <WhyLink what={t('simple.taxes.due.title')} sentence={dueWhy(PMT06, x, t)} testId="why-due-pmt06" />
          </div>
        )}
        <p className="mt-2 text-caption text-muted">{t('simple.taxes.due.source')}</p>
      </section>

      <GstSteps x={x} />
    </>
  )
}
