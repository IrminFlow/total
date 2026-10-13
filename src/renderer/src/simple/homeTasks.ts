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
  { id: 'sale', label: 'simple.home.addSale', screen: { name: 'voucher-entry', kindHint: 'sales' } }, // i18n-technical
  { id: 'purchase', label: 'simple.home.addPurchase', screen: { name: 'voucher-entry', kindHint: 'purchase' } }, // i18n-technical
  { id: 'money-in', label: 'simple.home.moneyIn', screen: { name: 'voucher-entry', kindHint: 'receipt' } }, // i18n-technical
  { id: 'money-out', label: 'simple.home.moneyOut', screen: { name: 'voucher-entry', kindHint: 'payment' } } // i18n-technical
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
      const row = home.gst?.kind === 'regular' ? home.gst.row : null
      // A quarterly filer's return opens on the quarter's first month (the screen is month by month).
      return { name: 'gstr3b', ...(row ? { month: row.quarterly && row.from ? row.from.slice(0, 7) : row.period } : {}) }
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
  return item.source === 'close' ? { name: 'assistants', tab: 'close', period } : { name: 'assistants', tab: 'anomalies' } // i18n-technical
}
