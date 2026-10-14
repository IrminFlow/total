import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { MessageKey } from '@shared/i18n'
import { formatQtyMilli } from '@shared/money'
import { needsReorder, type StockLevel, type StockRow } from '@shared/simple/stock'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useFeatures } from '../../lib/useFeatures'
import { useNav, useSession } from '../../state/stores'
import { Button, Page } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { NewProductDialog } from '../NewProductDialog'
import { ProductView } from './ProductView'
import { useAccountantView } from '../../lib/handoff'
import { AccountantViewButton } from '../AccountantViewButton'

const LEVEL_TEXT: Record<StockLevel, MessageKey> = {
  ok: 'simple.stock.level.ok',
  low: 'simple.stock.level.low',
  out: 'simple.stock.level.out'
}
const LEVEL_CLS: Record<StockLevel, string> = {
  ok: 'border-line bg-panel2 text-muted',
  low: 'border-amber/60 bg-amberbar/10 text-ink',
  out: 'border-danger/50 bg-danger-soft text-danger'
}

export function LevelChip({ level }: { level: StockLevel }): React.JSX.Element | null {
  const t = useT()
  if (level === 'ok') return null
  const label = t(LEVEL_TEXT[level]) // i18n-technical: typed key table
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-caption ${LEVEL_CLS[level]}`} data-testid="stock-level" data-level={level}>
      {label}
    </span>
  )
}

const COUNT_SCREEN = { name: 'simple-stock-count' } as const // i18n-technical
const MADE_SCREEN = { name: 'simple-made-goods' } as const // i18n-technical
const SUMMARY_SCREEN = { name: 'stock-summary' } as const // i18n-technical

/**
 * WP 9.7 — Stock (plan §2.2): every product with what is on hand, what it is worth (the Stock
 * summary's own valuation pass, as on today — simple:stock:list), its selling price and a chip
 * when it is running low or out. "Running low" shows only those (Home's attention row opens it
 * that way). A row opens the product's simple view; "+ New product" is the plain product dialog.
 */
export function StockList({ filter, itemId }: { filter?: 'low'; itemId?: number }): React.JSX.Element {
  if (itemId != null) return <ProductView itemId={itemId} />
  return <StockTable initialFilter={filter} />
}

function StockTable({ initialFilter }: { initialFilter?: 'low' }): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const openFull = useAccountantView('simple-stock') // i18n-technical: screen name
  const queryClient = useQueryClient()
  const workingDate = useSession((s) => s.workingDate)
  const features = useFeatures()
  const [onlyLow, setOnlyLow] = useState(initialFilter === 'low')
  const [creating, setCreating] = useState(false)
  const { data, isLoading } = useQuery({ queryKey: ['simpleStock', workingDate], queryFn: () => api.simpleStock.list(workingDate) }) // i18n-technical
  const all = data?.rows ?? []
  const rows = onlyLow ? all.filter((r) => needsReorder(r.level)) : all

  const columns = useMemo(
    () =>
      defineColumns<StockRow>([
        { id: 'name', header: t('simple.stock.col.product'), kind: 'text', hideable: false, groupable: false, value: (r) => r.name }, // i18n-technical
        {
          id: 'qty', header: t('simple.stock.col.onHand'), kind: 'quantity', groupable: false, filterable: false, // i18n-technical
          value: (r) => r.qtyMilli,
          text: (r) => t('simple.stock.qtyUnit', { qty: formatQtyMilli(r.qtyMilli), unit: r.unit })
        },
        { id: 'value', header: t('simple.stock.col.worth'), kind: 'money', value: (r) => r.value, aggregate: 'sum', explainable: false }, // i18n-technical
        { id: 'price', header: t('simple.stock.col.price'), kind: 'money', value: (r) => r.sellingPrice, explainable: false }, // i18n-technical
        {
          id: 'level', header: t('simple.stock.col.level'), kind: 'text', groupable: false, filterable: false, // i18n-technical
          value: (r) => (r.level === 'ok' ? '' : t(LEVEL_TEXT[r.level])), // i18n-technical: typed key table
          cell: (r) => <LevelChip level={r.level} />
        }
      ]),
    [t]
  )

  const tab = (low: boolean): string =>
    `rounded px-3 py-1 text-detail ${onlyLow === low ? 'bg-panel font-medium text-ink shadow-elev-1 ring-1 ring-line' : 'text-muted hover:text-ink'}`

  return (
    <Page data-testid="simple-stock">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.stock.title')}</h1>
          <p className="mt-1 text-detail text-muted">{t('simple.stock.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AccountantViewButton testId="btn-stock-accountant-view" title={t('simple.stock.accountantHint')} onOpen={(always) => void openFull({ intent: null, always, fallback: SUMMARY_SCREEN })} />
          {features.manufacturing && (
            <Button data-testid="btn-stock-made-goods" onClick={() => nav.go(MADE_SCREEN)}>
              {t('simple.stock.madeGoods')}
            </Button>
          )}
          <Button data-testid="btn-stock-count" onClick={() => nav.go(COUNT_SCREEN)}>
            {t('simple.stock.count')}
          </Button>
          <Button variant="primary" data-testid="btn-stock-new-product" onClick={() => setCreating(true)}>
            {t('simple.stock.newProduct')}
          </Button>
        </div>
      </div>
      <section className="rounded-lg border border-line bg-panel shadow-elev-1">
        <DataTable
          testId="simple-stock"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.itemId}
          rowAttrs={(r) => ({ 'data-row-id': r.itemId, 'data-level': r.level })}
          loading={isLoading}
          toolbarFeatures={{ quickFilter: true, columns: false, groupBy: false, density: false, views: false }}
          toolbarStart={
            <div role="radiogroup" aria-label={t('simple.stock.showLabel')} className="inline-flex rounded-md border border-line bg-panel2 p-0.5">
              <button type="button" role="radio" aria-checked={!onlyLow} data-testid="stock-show-all" className={tab(false)} onClick={() => setOnlyLow(false)}>
                {t('simple.stock.showAll')}
              </button>
              <button type="button" role="radio" aria-checked={onlyLow} data-testid="stock-show-low" className={tab(true)} onClick={() => setOnlyLow(true)}>
                {t('simple.stock.showLow', { count: data?.lowCount ?? 0 })}
              </button>
            </div>
          }
          empty={{
            title: onlyLow ? t('simple.stock.noneLow') : t('simple.stock.empty'),
            action: onlyLow ? undefined : (
              <Button variant="primary" data-testid="btn-stock-empty-new" onClick={() => setCreating(true)}>
                {t('simple.stock.newProduct')}
              </Button>
            )
          }}
          totalsLabel={t('simple.stock.totalWorth')}
          onRowActivate={(r) => nav.go({ name: 'simple-stock', itemId: r.itemId })} // i18n-technical
        />
      </section>
      {creating && (
        <NewProductDialog
          name=""
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            void queryClient.invalidateQueries({ queryKey: ['simpleStock'] }) // i18n-technical
            nav.go({ name: 'simple-stock', itemId: id }) // i18n-technical
          }}
        />
      )}
    </Page>
  )
}
