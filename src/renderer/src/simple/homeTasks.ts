import type { MessageKey } from '@shared/i18n'
import type { HomeAttentionItem, SimpleHomeData } from '@shared/simple/home'
import type { Screen } from '../state/stores'

export type HomeTaskId = 'sale' | 'purchase' | 'money-in' | 'money-out'

/**
 * WP 8.6: Home's big task buttons and where each one goes — the ONE mapping. Today they open the
 * existing editors in the right mode (accountant-only screens, so they show in the full app via
 * the WP 8.1 hand-off); Phase 9 swaps a target for its simple flow by changing its `screen` here.
 */
export const HOME_TASKS: readonly { id: HomeTaskId; label: MessageKey; screen: Screen }[] = [
  // WP 9.2: + Sale opens the simple Make a bill flow.
  { id: 'sale', label: 'simple.home.addSale', screen: { name: 'simple-sell' } }, // i18n-technical
  // WP 9.3: + Purchase opens the simple Record a purchase flow.
  { id: 'purchase', label: 'simple.home.addPurchase', screen: { name: 'simple-buy' } }, // i18n-technical
  // WP 9.4: + Money in / + Money out open the simple Money flows.
  { id: 'money-in', label: 'simple.home.moneyIn', screen: { name: 'simple-money-in' } }, // i18n-technical
  { id: 'money-out', label: 'simple.home.moneyOut', screen: { name: 'simple-money-out' } } // i18n-technical
]

export type HomeReport = 'day' | 'receivables' | 'payables' | 'cash' | 'profit' | 'gst' | 'backups'

/** Where each tile's "Why?" link goes — the accountant screen showing THAT figure (same period,
 *  same side, same as-on date); they open in the full app with "Back to simple". */
export function homeReportScreen(id: HomeReport, home: SimpleHomeData): Screen {
  switch (id) {
    case 'day':
      return { name: 'daybook', date: home.today } // i18n-technical
    case 'receivables':
      return { name: 'outstandings', side: 'receivable' } // i18n-technical
    case 'payables':
      return { name: 'outstandings', side: 'payable' } // i18n-technical
    case 'cash':
      return { name: 'trial-balance', asOn: home.today, ledgerIds: home.cash.accounts.map((a) => a.ledgerId) }
    case 'profit':
      return { name: 'profit-loss' }
    case 'gst': {
      // WP 9.9: the simple Taxes screen on the tile's period (a quarter is named by its last month,
      // which simple:taxes reads as the quarter); its Accountant view is GSTR-3B.
      const row = home.gst?.kind === 'regular' ? home.gst.row : null
      return { name: 'simple-taxes', ...(row ? { period: row.period } : {}) } // i18n-technical
    }
    case 'backups':
      return { name: 'settings', tab: 'backups' } // i18n-technical
  }
}

/** A cash / bank account's statement. */
export const accountScreen = (ledgerId: number): Screen => ({ name: 'ledger-statement', ledgerId })

/** "Needs attention" rows: overdue bills open Outstandings on their side; the rest the Assistants
 *  screen on the tab they came from. */
export function attentionScreen(item: Pick<HomeAttentionItem, 'source' | 'key'>, period: string): Screen {
  if (item.source === 'owed') return { name: 'outstandings', side: item.key === 'payable' ? 'payable' : 'receivable' } // i18n-technical
  // WP 9.7: products running low → the Stock list, filtered to them.
  if (item.source === 'stock') return { name: 'simple-stock', filter: 'low' } // i18n-technical
  return item.source === 'close' ? { name: 'assistants', tab: 'close', period } : { name: 'assistants', tab: 'anomalies' } // i18n-technical
}
