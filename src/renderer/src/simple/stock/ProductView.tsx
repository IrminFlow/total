import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { MessageKey } from '@shared/i18n'
import { formatPaise, formatQtyMilli } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import { mapError, type CaughtError } from '@shared/errors'
import type { StockHistoryRow, StockHistoryWhat } from '@shared/simple/stock'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useFeatures } from '../../lib/useFeatures'
import { useNav, useSession } from '../../state/stores'
import { AmountInput, Button, Field, Page } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { LevelChip } from './StockList'
import { useCanSave } from '../ViewerNote'

const WHAT_TEXT: Record<StockHistoryWhat, MessageKey> = {
  opening: 'simple.stock.what.opening',
  bought: 'simple.stock.what.bought',
  sold: 'simple.stock.what.sold',
  returnedIn: 'simple.stock.what.returnedIn',
  returnedOut: 'simple.stock.what.returnedOut',
  counted: 'simple.stock.what.counted',
  made: 'simple.stock.what.made',
  used: 'simple.stock.what.used',
  sent: 'simple.stock.what.sent',
  received: 'simple.stock.what.received',
  adjusted: 'simple.stock.what.adjusted',
  other: 'simple.stock.what.other'
}

const editScreen = (itemId: number): { name: 'masters'; tab: 'items'; itemId: number } => ({ name: 'masters', tab: 'items', itemId }) // i18n-technical
const makeScreen = (itemId: number): { name: 'simple-made-goods'; itemId: number } => ({ name: 'simple-made-goods', itemId }) // i18n-technical
const NO_MAX = 'none' // i18n-technical: the history grows with the page
const movementsScreen = (itemId: number): { name: 'stock-movements'; itemId: number } => ({ name: 'stock-movements', itemId }) // i18n-technical

/**
 * WP 9.7 — one product as the simple view shows it (simple:stock:product): what is on hand and
 * what it is worth (the Stock summary's figures), what one cost, the selling price with "Change
 * price" (the default price list's row from today — earlier bills keep their price), the recipe
 * in plain words when it has one, and its History this year (the Stock movements register, in
 * words). "Edit in the full app" opens the product's full form.
 */
export function ProductView({ itemId }: { itemId: number }): React.JSX.Element {
  const t = useT()
  const canSave = useCanSave()
  const nav = useNav()
  const queryClient = useQueryClient()
  const workingDate = useSession((s) => s.workingDate)
  const features = useFeatures()
  const { data: p, isLoading } = useQuery({ queryKey: ['simpleStockProduct', itemId, workingDate], queryFn: () => api.simpleStock.product(itemId, workingDate) }) // i18n-technical
  const [editingPrice, setEditingPrice] = useState(false)
  const [price, setPrice] = useState<number | null>(null)
  const [priceError, setPriceError] = useState<string | null>(null)
  const [savingPrice, setSavingPrice] = useState(false)
  const money = (v: number): string => formatPaise(v, { symbol: true })

  const columns = useMemo(
    () =>
      defineColumns<StockHistoryRow>([
        { id: 'date', header: t('simple.stock.col.date'), kind: 'date', value: (r) => r.date, text: (r) => toPlainDate(r.date, t.lang), width: 130, groupable: false }, // i18n-technical
        {
          id: 'what', header: t('simple.stock.col.what'), kind: 'text', groupable: false, // i18n-technical
          value: (r) => (r.party ? t('simple.stock.whatWho', { what: t(WHAT_TEXT[r.what]), name: r.party }) : t(WHAT_TEXT[r.what])) // i18n-technical: typed key table
        },
        { id: 'in', header: t('simple.stock.col.in'), kind: 'quantity', value: (r) => r.inMilli || null, text: (r) => (r.inMilli ? formatQtyMilli(r.inMilli) : ''), filterable: false }, // i18n-technical
        { id: 'out', header: t('simple.stock.col.out'), kind: 'quantity', value: (r) => r.outMilli || null, text: (r) => (r.outMilli ? formatQtyMilli(r.outMilli) : ''), filterable: false }, // i18n-technical
        { id: 'balance', header: t('simple.stock.col.left'), kind: 'quantity', value: (r) => r.balanceMilli, text: (r) => formatQtyMilli(r.balanceMilli), filterable: false } // i18n-technical
      ]),
    [t]
  )

  if (isLoading) return <Page data-testid="simple-stock-product">{null}</Page>
  if (!p) {
    return (
      <Page data-testid="simple-stock-product">
        <button type="button" className="mb-3 text-detail text-blue hover:underline" onClick={() => nav.back()}>
          {t('simple.stock.back')}
        </button>
        <p className="text-detail text-muted" data-testid="simple-stock-product-missing">{t('simple.stock.missing')}</p>
      </Page>
    )
  }

  const savePrice = async (): Promise<void> => {
    if (price == null || price <= 0) {
      setPriceError(t('simple.stock.err.price'))
      return
    }
    setSavingPrice(true)
    setPriceError(null)
    try {
      await api.simpleStock.setPrice(p.itemId, price, workingDate)
      setEditingPrice(false)
      for (const k of ['simpleStockProduct', 'simpleStock', 'priceLevels']) void queryClient.invalidateQueries({ queryKey: [k] }) // i18n-technical
    } catch (err) {
      const m = mapError(err as CaughtError, { simple: true, t })
      setPriceError([m.general, ...Object.values(m.fields)].filter(Boolean).join(' ') || t('errors.generic'))
    } finally {
      setSavingPrice(false)
    }
  }

  const unit = p.unit
  const recipeText = p.recipe
    ? t('simple.stock.recipeLine', {
        name: p.name,
        list: p.recipe.lines.map((l) => t('simple.stock.intent.usedItem', { name: l.name, qty: formatQtyMilli(l.qtyMilliPerUnit), unit: l.unit })).join(', ')
      })
    : null

  return (
    <Page data-testid="simple-stock-product" data-item={p.itemId}>
      <button type="button" className="mb-3 text-detail text-blue hover:underline" data-testid="btn-stock-product-back" onClick={() => nav.back()}>
        {t('simple.stock.back')}
      </button>
      <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{p.name}</h1>
            <p className="mt-1 text-detail text-muted">{t('simple.stock.asOn', { date: toPlainDate(p.asOn, t.lang) })}</p>
          </div>
          <LevelChip level={p.level} />
        </div>

        <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-2 text-body sm:grid-cols-2">
          <div>
            <dt className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.stock.col.onHand')}</dt>
            <dd className="num text-lead font-semibold text-ink" data-testid="stock-product-qty" data-milli={p.qtyMilli}>
              {t('simple.stock.qtyUnit', { qty: formatQtyMilli(p.qtyMilli), unit })}
            </dd>
          </div>
          <div>
            <dt className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.stock.col.worth')}</dt>
            <dd className="num text-lead font-semibold text-ink" data-testid="stock-product-value" data-paise={p.value}>
              {money(p.value)}
            </dd>
            {p.unitCost != null && <dd className="text-small text-muted">{t('simple.stock.unitCost', { amount: money(p.unitCost), unit })}</dd>}
          </div>
          <div>
            <dt className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.stock.col.price')}</dt>
            {editingPrice ? (
              <dd className="mt-1 flex flex-wrap items-end gap-2">
                <Field label={t('simple.stock.newPrice', { unit })} name="price" error={priceError}>
                  <AmountInput paise={price} onPaise={setPrice} onEnter={() => void savePrice()} autoFocus testId="input-stock-price" />
                </Field>
                <Button variant="primary" disabled={savingPrice} data-testid="btn-stock-price-save" onClick={() => void savePrice()}>
                  {t('common.save')}
                </Button>
                <Button disabled={savingPrice} data-testid="btn-stock-price-cancel" onClick={() => setEditingPrice(false)}>
                  {t('common.cancel')}
                </Button>
              </dd>
            ) : (
              <dd className="flex flex-wrap items-baseline gap-3">
                <span className="num text-lead font-semibold text-ink" data-testid="stock-product-price" data-paise={p.sellingPrice ?? ''}>
                  {p.sellingPrice != null ? t('simple.stock.perUnit', { amount: money(p.sellingPrice), unit }) : t('simple.stock.noPrice')}
                </span>
                {canSave && (
                  <button
                    type="button"
                    className="text-detail text-blue hover:underline"
                    data-testid="btn-stock-change-price"
                    onClick={() => {
                      setPrice(p.sellingPrice)
                      setPriceError(null)
                      setEditingPrice(true)
                    }}
                  >
                    {t('simple.stock.changePrice')}
                  </button>
                )}
              </dd>
            )}
            {editingPrice && <dd className="mt-1 text-small text-muted">{t('simple.stock.priceFrom', { date: toPlainDate(workingDate, t.lang) })}</dd>}
          </div>
          <div>
            <dt className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.stock.lowAt')}</dt>
            <dd className="text-body text-ink" data-testid="stock-product-reorder">
              {p.reorderLevelMilli != null && p.reorderLevelMilli > 0
                ? t('simple.stock.lowBelow', { qty: formatQtyMilli(p.reorderLevelMilli), unit })
                : t('simple.stock.lowWhenOut')}
            </dd>
          </div>
          {(p.gstRate != null || p.hsn) && (
            <div>
              <dt className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.stock.gst')}</dt>
              <dd className="text-body text-ink">
                {[p.gstRate != null ? t('simple.stock.gstRate', { rate: p.gstRate }) : null, p.hsn ? t('simple.stock.hsn', { code: p.hsn }) : null].filter(Boolean).join(' · ')}
              </dd>
            </div>
          )}
        </dl>

        {recipeText && (
          <p className="mt-4 rounded-md border border-line bg-panel2 px-3 py-2 text-body text-ink" data-testid="stock-product-recipe">
            {recipeText}
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {p.recipe && features.manufacturing && (
            <Button variant="primary" data-testid="btn-stock-make" onClick={() => nav.go(makeScreen(p.itemId))}>
              {t('simple.stock.makeSome')}
            </Button>
          )}
          <Button data-testid="btn-stock-product-edit" title={t('simple.stock.editHint')} onClick={() => nav.go(editScreen(p.itemId))}>
            {t('simple.stock.edit')}
          </Button>
        </div>
      </section>

      <section className="mt-5 rounded-lg border border-line bg-panel shadow-elev-1" aria-label={t('simple.stock.history')}>
        <div className="flex flex-wrap items-baseline justify-between gap-3 px-panel pt-panel">
          <h2 className="text-subtitle font-semibold text-ink">{t('simple.stock.history')}</h2>
          <span className="text-small text-muted" data-testid="stock-history-opening">
            {t('simple.stock.historyFrom', { date: toPlainDate(p.history.from, t.lang), qty: formatQtyMilli(p.history.openingMilli), unit })}
          </span>
        </div>
        <DataTable
          testId="stock-history"
          columns={columns}
          rows={p.history.rows}
          rowKey={(_r, i) => i}
          toolbarFeatures={{ quickFilter: false, columns: false, groupBy: false, density: false, views: false }}
          empty={{ title: t('simple.stock.historyEmpty') }}
          totals={false}
          maxHeight={NO_MAX}
        />
        <div className="px-panel pb-panel">
          <button type="button" className="mt-2 text-detail text-blue hover:underline" data-testid="btn-stock-history-full" onClick={() => nav.go(movementsScreen(p.itemId))}>
            {t('simple.stock.historyFull')}
          </button>
        </div>
      </section>
    </Page>
  )
}
