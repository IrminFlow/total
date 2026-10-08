// Screen sources (a tool's `{ kind: 'screen', screen, params }`) → navigation targets. Unknown
// screens return null and render as plain text.
import type { AiSource } from '@shared/ai'
import type { Screen } from '../../state/stores'

const PLAIN: readonly string[] = [
  'company-info', 'trial-balance', 'profit-loss', 'balance-sheet', 'outstandings', 'daybook', 'stock-summary', 'gstr3b', 'tds',
  'manufacture-register', 'pending-challans', 'pending-grns', 'pending-sales-orders', 'pending-purchase-orders', 'banking', 'budgets',
  'cash-forecast'
]

export function screenFor(s: Extract<AiSource, { kind: 'screen' }>): Screen | null {
  const p = s.params ?? {}
  switch (s.screen) {
    case 'ledger-statement':
      return typeof p.ledgerId === 'number' ? { name: 'ledger-statement', ledgerId: p.ledgerId } : null
    case 'stock-movements':
      return { name: 'stock-movements', ...(typeof p.itemId === 'number' ? { itemId: p.itemId } : {}) }
    case 'search':
      return { name: 'search', q: typeof p.q === 'string' ? p.q : undefined }
    case 'voucher-entry':
      return typeof p.aiDraftId === 'number' ? { name: 'voucher-entry', aiDraftId: p.aiDraftId } : null
    case 'audit-trail':
      return { name: 'audit-trail', ...(typeof p.voucherId === 'number' ? { voucherId: p.voucherId } : {}) }
    case 'masters':
      return { name: 'masters', tab: 'ledgers' }
    default:
      return PLAIN.includes(s.screen) ? ({ name: s.screen } as Screen) : null
  }
}
