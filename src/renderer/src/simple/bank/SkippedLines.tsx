import { formatPaise } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import type { BankLineView } from '@shared/simple/bank'
import { useT } from '../../lib/i18n'
import { lineKey } from './skipped'

/**
 * The open statement lines the user answered "Skip for now" (remembered on this computer —
 * skipped.ts), under a collapsed group: each with "Bring back", which puts it with the lines to
 * answer again. Nothing here touches the books.
 */
export function SkippedLines({ lines, onBringBack }: { lines: BankLineView[]; onBringBack: (key: string) => void }): React.JSX.Element {
  const t = useT()
  return (
    <details className="rounded-lg border border-line bg-panel2 px-4 py-3" data-testid="bank-skipped">
      <summary className="cursor-pointer text-subtitle font-semibold text-ink">
        {t('simple.bank.skippedTitle')} <span className="text-detail font-normal text-muted">{t('simple.bank.toAnswerCount', { count: lines.length })}</span>
      </summary>
      <p className="mt-2 text-small text-muted">{t('simple.bank.skippedHint')}</p>
      <ul className="mt-2 flex flex-col divide-y divide-line">
        {lines.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-2" data-testid="bank-skipped-line" data-line-id={l.id}>
            <div className="min-w-0">
              <p className="text-small text-muted">
                {toPlainDate(l.date, t.lang)} · {l.side === 'deposit' ? t('simple.bank.in') : t('simple.bank.out')}
              </p>
              <p className="truncate text-detail text-ink" title={l.description}>
                {l.description}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="num text-detail font-semibold text-ink">{formatPaise(l.amount, { symbol: true })}</span>
              <button type="button" className="text-small text-blue hover:underline" data-testid={`btn-bank-bring-back-${l.id}`} onClick={() => onBringBack(lineKey(l))}>
                {t('simple.bank.bringBack')}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </details>
  )
}
