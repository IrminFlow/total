import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toPlainDate } from '@shared/dates'
import { LEFT_TEXT, type ReturnBillRow, type ReturnSide } from '@shared/simple/returns'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useSession } from '../../state/stores'
import { TextInput } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'

const LEFT_CLS: Record<ReturnBillRow['left'], string> = {
  all: 'border-line bg-panel2 text-ink',
  part: 'border-amber/60 bg-amberbar/10 text-ink',
  none: 'border-line bg-panel2 text-muted'
}

function LeftChip({ left }: { left: ReturnBillRow['left'] }): React.JSX.Element {
  const t = useT()
  const label = t(LEFT_TEXT[left]) // i18n-technical: typed key table
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-caption ${LEFT_CLS[left]}`} data-testid="return-left" data-left={left}>
      {label}
    </span>
  )
}

/**
 * WP 9.5 — "Which bill is this return for?": the recent bills (last 12 months, newest first) with
 * what has come back already and whether anything is still returnable. Typing searches the
 * customer / supplier name and the bill number at any date (simple:returns:bills `q`). A row
 * picks the bill.
 */
export function BillPicker({ side, onPick }: { side: ReturnSide; onPick: (billId: number) => void }): React.JSX.Element {
  const t = useT()
  const workingDate = useSession((s) => s.workingDate)
  const sale = side === 'sale' // i18n-technical
  const [typed, setTyped] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const id = window.setTimeout(() => setQ(typed.trim()), 250)
    return () => window.clearTimeout(id)
  }, [typed])
  const { data, isLoading } = useQuery({
    queryKey: ['simpleReturnBills', side, workingDate, q], // i18n-technical
    queryFn: () => api.simple.returnBills(side, workingDate, q || undefined)
  })
  const rows = data ?? []
  const columns = useMemo(
    () =>
      defineColumns<ReturnBillRow>([
        { id: 'date', header: t('simple.sales.col.date'), kind: 'date', value: (r) => r.date, text: (r) => toPlainDate(r.date), width: 130, groupable: false }, // i18n-technical
        {
          id: 'number', header: sale ? t('simple.sales.col.number') : t('simple.returns.col.theirBill'), kind: 'text', width: 130, groupable: false,
          value: (r) => (sale ? r.number : (r.billNo ?? r.number))
        },
        {
          id: 'party', // i18n-technical
          header: sale ? t('simple.sales.col.customer') : t('simple.returns.col.supplier'), kind: 'text', hideable: false, groupable: false,
          value: (r) => (r.walkIn ? t('simple.sales.cashCustomer') : r.partyName)
        },
        { id: 'total', header: t('simple.sales.col.total'), kind: 'money', value: (r) => r.total, explainable: false }, // i18n-technical
        { id: 'returned', header: t('simple.returns.col.returned'), kind: 'money', value: (r) => (r.returned > 0 ? r.returned : null), explainable: false }, // i18n-technical
        {
          id: 'left', header: t('simple.returns.col.left'), kind: 'text', groupable: false, filterable: false, // i18n-technical
          value: (r) => t(LEFT_TEXT[r.left]), // i18n-technical: typed key table
          cell: (r) => <LeftChip left={r.left} />
        }
      ]),
    [t, sale]
  )
  return (
    <section className="rounded-lg border border-line bg-panel shadow-elev-1" aria-label={t('simple.returns.whichBill')} data-testid="return-bill-picker">
      <div className="flex flex-wrap items-end justify-between gap-3 p-panel pb-3">
        <div>
          <h2 className="text-subtitle font-semibold text-ink">{t('simple.returns.whichBill')}</h2>
          <p className="mt-1 text-detail text-muted">{sale ? t('simple.returns.pickHint') : t('simple.returns.pickHintBuy')}</p>
        </div>
        <div className="w-full max-w-xs">
          <TextInput
            value={typed}
            autoFocus
            placeholder={sale ? t('simple.returns.searchPlaceholder') : t('simple.returns.searchPlaceholderBuy')}
            aria-label={sale ? t('simple.returns.searchPlaceholder') : t('simple.returns.searchPlaceholderBuy')}
            onChange={(e) => setTyped(e.target.value)}
            data-testid="input-return-search"
          />
        </div>
      </div>
      <DataTable
        testId="return-bills"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.voucherId}
        rowAttrs={(r) => ({ 'data-row-id': r.voucherId, 'data-left': r.left })}
        loading={isLoading}
        totals={false}
        toolbarFeatures={{ quickFilter: false, columns: false, groupBy: false, density: false, views: false }}
        empty={{ title: q ? t('simple.returns.noMatch') : sale ? t('simple.returns.noBills') : t('simple.returns.noBillsBuy') }}
        onRowActivate={(r) => onPick(r.voucherId)}
      />
    </section>
  )
}
