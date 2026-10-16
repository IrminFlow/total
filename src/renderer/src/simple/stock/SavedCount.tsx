import { useQuery } from '@tanstack/react-query'
import { formatPaise, formatQtyMilli } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import { countDifference } from '@shared/simple/stock'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useNav } from '../../state/stores'
import { Button, Page } from '../../components/ui'

const QUERY_KEY = 'simpleStockCount' // i18n-technical
const entryScreen = (voucherId: number): { name: 'voucher-entry'; voucherId: number } => ({ name: 'voucher-entry', voucherId }) // i18n-technical

/**
 * A saved stock count reopened (Stock → a product's History → "Counted"): per product what Total
 * showed just before the count, what was counted, and the difference with what it did to the
 * stock's worth — the valuation engine's figures (simple:stock:count), so a reopened count never
 * reads "Matches" because the total already includes it. "Edit in the full app" opens the entry.
 */
export function SavedCount({ voucherId }: { voucherId: number }): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const { data: c, isLoading } = useQuery({ queryKey: [QUERY_KEY, voucherId], queryFn: () => api.simpleStock.count(voucherId) })
  const money = (v: number): string => formatPaise(v, { symbol: true })
  const back = (
    <button type="button" className="mb-3 text-detail text-blue hover:underline" data-testid="btn-saved-count-back" onClick={() => nav.back()}>
      {t('common.back')}
    </button>
  )
  if (isLoading) return <Page data-testid="simple-saved-count">{null}</Page>
  if (!c) {
    return (
      <Page data-testid="simple-saved-count">
        {back}
        <p className="text-detail text-muted" data-testid="saved-count-missing">{t('simple.stock.saved.missing')}</p>
      </Page>
    )
  }
  return (
    <Page data-testid="simple-saved-count" data-voucher={c.voucherId}>
      {back}
      <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.stock.saved.title', { number: c.number })}</h1>
            <p className="mt-1 text-detail text-muted">{t('simple.stock.saved.on', { date: toPlainDate(c.date, t.lang) })}</p>
            {c.narration && <p className="mt-1 text-detail text-ink">{c.narration}</p>}
          </div>
          <Button data-testid="btn-saved-count-edit" onClick={() => nav.go(entryScreen(c.voucherId))}>
            {t('simple.stock.edit')}
          </Button>
        </div>
        {!c.inBooks && (
          <p role="note" className="mt-3 rounded-md border border-line bg-panel2 px-3 py-2 text-detail text-ink" data-testid="saved-count-binned">
            {t('simple.stock.saved.binned')}
          </p>
        )}
        <ul className="mt-4 divide-y divide-line" data-testid="saved-count-rows">
          {c.lines.map((l) => {
            const qty = (m: number): string => t('simple.stock.qtyUnit', { qty: formatQtyMilli(m), unit: l.unit })
            const d = l.beforeMilli != null ? countDifference(l.beforeMilli, l.countedMilli) : null
            return (
              <li key={l.lineId} className="grid grid-cols-1 items-baseline gap-2 py-2 sm:grid-cols-[2fr_1fr_1fr_2fr]" data-testid={`saved-count-row-${l.itemId}`}>
                <span className="text-body text-ink">{l.name}</span>
                <span className="num text-detail text-muted">{l.beforeMilli != null ? t('simple.stock.saved.showed', { qty: qty(l.beforeMilli) }) : ''}</span>
                <span className="num text-detail text-ink">{t('simple.stock.saved.counted', { qty: qty(l.countedMilli) })}</span>
                <span
                  className={`text-detail ${d?.kind === 'short' ? 'text-danger' : 'text-ink'}`}
                  data-testid={`saved-count-diff-${l.itemId}`}
                  data-kind={d?.kind ?? 'none'}
                  data-milli={d?.milli ?? ''}
                  data-value={l.valueChange ?? ''}
                >
                  {d == null
                    ? ''
                    : [
                        d.kind === 'same' ? t('simple.stock.count.same') : d.kind === 'short' ? t('simple.stock.count.short', { qty: qty(d.milli) }) : t('simple.stock.saved.extra', { qty: qty(d.milli) }),
                        l.valueChange != null && l.valueChange !== 0
                          ? l.valueChange < 0
                            ? t('simple.stock.saved.worthLess', { amount: money(-l.valueChange) })
                            : t('simple.stock.saved.worthMore', { amount: money(l.valueChange) })
                          : null
                      ]
                        .filter(Boolean)
                        .join(' — ')}
                </span>
              </li>
            )
          })}
        </ul>
      </section>
    </Page>
  )
}
