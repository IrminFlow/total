import { formatPaise, formatQtyMilli } from '@shared/money'
import type { ReturnBill, ReturnForm } from '@shared/simple/returns'
import { useT } from '../../lib/i18n'
import { FieldError, TextInput } from '../../components/ui'

/**
 * WP 9.5 — "What came back, and how many?": each product on the bill with what was sold, what came
 * back already and what is still returnable; the quantity coming back is typed per line (or "All"
 * of what is left). The value of each line is the editor's calculation (returnTotals), shown here.
 */
export function ReturnLines({
  bill,
  form,
  amounts,
  error,
  onChange
}: {
  bill: ReturnBill
  form: ReturnForm
  amounts: Record<string, number | null>
  error: string | null
  onChange: (qty: Record<string, string>) => void
}): React.JSX.Element {
  const t = useT()
  const money = (p: number): string => formatPaise(p, { symbol: true })
  const set = (uid: string, text: string): void => onChange({ ...form.qty, [uid]: text })
  return (
    <div data-testid="return-lines">
      <ul className="divide-y divide-line">
        {bill.lines.map((l, i) => {
          const back = l.qtyMilli - l.leftMilli
          const done = l.leftMilli <= 0
          const value = amounts[l.lineUid]
          return (
            <li key={l.lineUid} className="grid grid-cols-1 items-center gap-2 py-2 md:grid-cols-[minmax(0,1fr)_9rem_8rem]" data-testid={`return-line-${i}`}>
              <div className="min-w-0">
                <p className="text-body text-ink">{l.name}</p>
                <p className="text-small text-muted">
                  {t('simple.returns.sold', { qty: formatQtyMilli(l.qtyMilli), unit: l.unit, rate: money(l.ratePaise) })}
                  {back > 0 && ` · ${t('simple.returns.backAlready', { qty: formatQtyMilli(back), unit: l.unit })}`}
                </p>
              </div>
              {done ? (
                <p className="text-small text-muted md:col-span-2" data-testid={`return-line-done-${i}`}>
                  {t('simple.returns.allBack')}
                </p>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <TextInput
                      className="w-20 text-right"
                      inputMode="decimal"
                      value={form.qty[l.lineUid] ?? ''}
                      placeholder="0" // i18n-technical: a number
                      aria-label={t('simple.returns.qtyBack', { name: l.name })}
                      onChange={(e) => set(l.lineUid, e.target.value)}
                      data-testid={`input-return-qty-${i}`}
                    />
                    <button
                      type="button"
                      className="text-small text-blue hover:underline"
                      title={t('simple.returns.allLeftHint', { qty: formatQtyMilli(l.leftMilli), unit: l.unit })}
                      onClick={() => set(l.lineUid, formatQtyMilli(l.leftMilli).replace(/,/g, ''))}
                      data-testid={`btn-return-all-${i}`}
                    >
                      {t('simple.returns.allLeft', { qty: formatQtyMilli(l.leftMilli) })}
                    </button>
                  </div>
                  <span className="num text-right text-body text-ink" data-testid={`return-line-amount-${i}`} data-paise={value ?? 0}>
                    {value != null && value > 0 ? money(value) : ''}
                  </span>
                </>
              )}
            </li>
          )
        })}
      </ul>
      <FieldError name="items" error={error} />
    </div>
  )
}
