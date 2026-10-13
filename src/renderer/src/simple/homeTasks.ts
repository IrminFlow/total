import type { MessageKey } from '@shared/i18n'
import type { Screen } from '../state/stores'

export type HomeTaskId = 'sale' | 'purchase' | 'money-in' | 'money-out'

/**
 * WP 8.6: Home's big task buttons and where each one goes — the ONE mapping. Today they open the
 * existing editors in the right mode (accountant-only screens, so they show in the full app via
 * the WP 8.1 hand-off); Phase 9 swaps a target for its simple flow by changing its `screen` here.
 */
export const HOME_TASKS: readonly { id: HomeTaskId; label: MessageKey; screen: Screen }[] = [
  { id: 'sale', label: 'simple.home.addSale', screen: { name: 'voucher-entry', kindHint: 'sales' } }, // i18n-technical
  { id: 'purchase', label: 'simple.home.addPurchase', screen: { name: 'voucher-entry', kindHint: 'purchase' } }, // i18n-technical
  { id: 'money-in', label: 'simple.home.moneyIn', screen: { name: 'voucher-entry', kindHint: 'receipt' } }, // i18n-technical
  { id: 'money-out', label: 'simple.home.moneyOut', screen: { name: 'voucher-entry', kindHint: 'payment' } } // i18n-technical
]

export type HomeReport = 'day' | 'owed' | 'cash' | 'profit' | 'gst' | 'backups'

/** Where each tile's "See the full report" goes — the accountant screens (they open in the full
 *  app with "Back to simple"). */
export const HOME_REPORTS: Record<HomeReport, Screen> = {
  day: { name: 'daybook' }, // i18n-technical
  owed: { name: 'outstandings' }, // i18n-technical
  cash: { name: 'cash-flow' },
  profit: { name: 'profit-loss' },
  gst: { name: 'gstr3b' },
  backups: { name: 'settings', tab: 'backups' } // i18n-technical
}

/** A cash / bank account's statement. */
export const accountScreen = (ledgerId: number): Screen => ({ name: 'ledger-statement', ledgerId })

/** "Needs attention" rows open the Assistants screen on the tab they came from. */
export const attentionScreen = (source: 'close' | 'anomaly', period: string): Screen =>
  source === 'close' ? { name: 'assistants', tab: 'close', period } : { name: 'assistants', tab: 'anomalies' } // i18n-technical
