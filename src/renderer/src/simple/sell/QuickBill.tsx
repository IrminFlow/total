import { useT } from '../../lib/i18n'
import { CounterBillingScreen } from '../../screens/CounterBilling'

/**
 * WP 9.2 — Sell → Quick bill: the existing Counter screen (scan / type a product, Enter adds it,
 * F5–F7 pay, ⌘↵ completes) inside the simple shell, with its header in plain words. The Counter
 * itself is unchanged — it posts a sales bill and its receipt as it always has.
 */
export function QuickBill(): React.JSX.Element {
  const t = useT()
  return <CounterBillingScreen title={t('simple.quickBill.title')} />
}
