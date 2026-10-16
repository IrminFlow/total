import { formatPaise } from '@shared/money'
import type { SimpleHandoff } from '@shared/simple/handoff'
import { useT } from '../lib/i18n'
import { Banner } from './ui'

/**
 * WP 9.10: above the full editor opened from a simple form's "Accountant view" — the answers are
 * filled in and nothing is saved until Save; the parts of the same answers this editor does not
 * hold (a payment made now, a refund), accounts that do not exist yet and are made on save (the
 * walk-in customer, GST / round-off ledgers), and accounts to pick or create. Plain words (t()), since
 * whoever reads it came from a simple screen.
 */
export function HandoffBanner({ handoff }: { handoff: SimpleHandoff }): React.JSX.Element {
  const t = useT()
  return (
    <Banner tone="info" className="mb-section" testId="handoff-banner" title={t('simple.handoff.title')}>
      <p>{t('simple.handoff.body')}</p>
      {handoff.others.map((o, i) => (
        <p key={i} className="mt-1" data-testid="handoff-other">
          {t(o.kind === 'receipt' ? 'simple.handoff.otherReceived' : 'simple.handoff.otherPaid', { amount: formatPaise(o.amount, { symbol: true }) })}
        </p>
      ))}
      {(handoff.addedOnSave?.length ?? 0) > 0 && (
        <p className="mt-1" data-testid="handoff-added-on-save">
          {t('simple.handoff.addedOnSave', { names: handoff.addedOnSave!.join(', '), count: handoff.addedOnSave!.length })}
        </p>
      )}
      {handoff.missing.length > 0 && (
        <p className="mt-1" data-testid="handoff-missing">
          {t('simple.handoff.missing', { names: handoff.missing.join(', '), count: handoff.missing.length })}
        </p>
      )}
    </Banner>
  )
}
