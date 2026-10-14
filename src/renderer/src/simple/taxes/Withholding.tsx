import type { TaxesWithholding } from '@shared/simple/taxes'
import { money, shortDate, withholdingUnpaidText } from '@shared/simple/explain'
import { useT } from '../../lib/i18n'
import { useNav } from '../../state/stores'
import { Button } from '../../components/ui'
import { cardCls } from '../reports/parts'

const TDS = { name: 'tds' } as const // i18n-technical
const TCS = { name: 'tcs' } as const // i18n-technical

/**
 * WP 9.9 — TDS / TCS answers, only while the feature is on and a payable account exists: what was
 * deducted (collected) this month and by when to pay it, and what is still unpaid (oldest first,
 * against every payment so far), each with its due date (rule 30(2) / the TCS rule). Links to the
 * accountant screens.
 */
export function WithholdingCards({ items, today }: { items: TaxesWithholding[]; today: string }): React.JSX.Element | null {
  const t = useT()
  const nav = useNav()
  if (items.length === 0) return null
  return (
    <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
      {items.map((w) => (
        <section key={w.kind} className={cardCls} data-testid={`taxes-${w.kind}`} data-paise={w.thisMonth}>
          <h2 className="text-subtitle font-semibold text-ink">{w.kind === 'tds' ? t('simple.taxes.tds.what') : t('simple.taxes.tcs.what')}</h2>
          <p className="mt-2 text-body text-ink" data-testid={`taxes-${w.kind}-this-month`}>
            {w.kind === 'tds'
              ? t('simple.taxes.withholding.thisMonthTds', { amount: money(w.thisMonth), date: shortDate(w.thisMonthDue, today) })
              : t('simple.taxes.withholding.thisMonthTcs', { amount: money(w.thisMonth), date: shortDate(w.thisMonthDue, today) })}
          </p>
          {w.unpaid.length === 0 ? (
            <p className="mt-1 text-detail text-muted">{t('simple.taxes.withholding.allPaid')}</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5 text-detail">
              {w.unpaid.map((u, i) => (
                <li key={i} className={u.late ? 'text-danger' : 'text-ink'}>
                  {withholdingUnpaidText(u, today, t)}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-caption text-muted">{t('simple.taxes.withholding.source')}</p>
          <Button className="mt-2" size="sm" onClick={() => nav.go(w.kind === 'tds' ? TDS : TCS)}>
            {w.kind === 'tds' ? t('simple.taxes.withholding.openTds') : t('simple.taxes.withholding.openTcs')}
          </Button>
        </section>
      ))}
    </div>
  )
}
