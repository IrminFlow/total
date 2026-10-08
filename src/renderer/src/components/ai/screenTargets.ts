// Screen sources (a tool's `{ kind: 'screen', screen, params }`) → navigation targets. Unknown
// screens return null and render as plain text.
import type { AiSource } from '@shared/ai'
import { nextDraftId, type Screen } from '../../state/stores'
import { reportModelSchema } from '@shared/reportBuilder/model'

const safeJson = (t: string): unknown => {
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

const PLAIN: readonly string[] = [
  'company-info', 'trial-balance', 'profit-loss', 'balance-sheet', 'outstandings', 'daybook', 'stock-summary', 'gstr3b', 'tds',
  'manufacture-register', 'pending-challans', 'pending-grns', 'pending-sales-orders', 'pending-purchase-orders', 'banking', 'budgets',
  'cash-forecast', 'unbilled-goods', 'exceptions', 'fixed-assets', 'gstr1', 'receivables', 'payables'
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
    // WP 5.5: build_report links the report builder pre-filled with the model it ran.
    case 'report-builder': {
      if (typeof p.model !== 'string') return { name: 'report-builder' }
      const parsed = reportModelSchema.safeParse(safeJson(p.model))
      return parsed.success
        ? { name: 'report-builder', model: parsed.data, modelName: typeof p.title === 'string' ? p.title : undefined, modelSeq: nextDraftId() }
        : { name: 'report-builder' }
    }
    case 'assistants': {
      const tab = p.tab === 'gst2b' || p.tab === 'anomalies' || p.tab === 'report' ? p.tab : 'close'
      return { name: 'assistants', tab, ...(typeof p.period === 'string' ? { period: p.period } : {}) }
    }
    case 'settings':
      // WP 5.6: the `remember` tool links to Settings → AI (the Memory table).
      return { name: 'settings', tab: 'ai' }
    default:
      return PLAIN.includes(s.screen) ? ({ name: s.screen } as Screen) : null
  }
}
