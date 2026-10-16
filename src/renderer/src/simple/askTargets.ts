// WP 10.1: where an Ask Total chip / link / "open X" goes. Main names a screen and its params
// (shared/assist.ts AssistTarget); this whitelist turns them into a Screen — anything else is
// not a link (never a free-form route).
import type { AssistTarget } from '@shared/assist'
import { PEOPLE_FILTERS, type PeopleFilter } from '@shared/simple/people'
import { SIMPLE_SECTION_IDS, type SimpleSectionId } from '@shared/simple/uiMode'
import type { Screen } from '../state/stores'

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
const REPORTS: readonly string[] = ['doing', 'cash', 'owed', 'by-month'] // i18n-technical
const PLAIN: readonly string[] = [
  'simple-money', 'simple-money-in', 'simple-money-out', 'simple-move-money', 'simple-sell', 'simple-buy',
  'simple-return-sale', 'simple-return-purchase', 'simple-stock-count', 'simple-looks', 'simple-features', 'simple-openings', 'gateway', 'profit-loss', 'stock-summary' // i18n-technical
]

export function askScreen(t: AssistTarget | undefined | null): Screen | null {
  if (!t) return null
  const p = t.params ?? {}
  switch (t.screen) {
    case 'simple-people': {
      const filter = str(p.filter)
      return { name: 'simple-people', ...(p.tab === 'bills' ? { tab: 'bills' as const } : {}), ...(filter && (PEOPLE_FILTERS as readonly string[]).includes(filter) ? { filter: filter as PeopleFilter } : {}) } // i18n-technical
    }
    case 'simple-sales':
      return { name: 'simple-sales', ...(num(p.billId) ? { billId: num(p.billId)! } : {}) } // i18n-technical
    case 'simple-purchases':
      return { name: 'simple-purchases', ...(num(p.billId) ? { billId: num(p.billId)! } : {}) } // i18n-technical
    case 'simple-person':
      return num(p.id) ? { name: 'simple-person', id: num(p.id)! } : null // i18n-technical
    case 'simple-bank':
      return { name: 'simple-bank', ...(num(p.bankId) ? { bankId: num(p.bankId)! } : {}) } // i18n-technical
    case 'simple-stock':
      return { name: 'simple-stock', ...(p.filter === 'low' ? { filter: 'low' as const } : {}), ...(num(p.itemId) ? { itemId: num(p.itemId)! } : {}) } // i18n-technical
    case 'simple-reports': {
      const report = str(p.report)
      return { name: 'simple-reports', ...(report && REPORTS.includes(report) ? { report: report as 'doing' } : {}) } // i18n-technical
    }
    case 'simple-taxes':
      return { name: 'simple-taxes', ...(str(p.period) ? { period: str(p.period)! } : {}) } // i18n-technical
    case 'simple-section': {
      const section = str(p.section)
      return section && (SIMPLE_SECTION_IDS as readonly string[]).includes(section) ? { name: 'simple-section', section: section as SimpleSectionId } : null // i18n-technical
    }
    case 'settings':
      return { name: 'settings', ...(p.tab === 'backups' ? { tab: 'backups' as const } : {}) } // i18n-technical
    case 'ledger-statement':
      return num(p.ledgerId) ? { name: 'ledger-statement', ledgerId: num(p.ledgerId)! } : null // i18n-technical
    case 'outstandings':
      return { name: 'outstandings', ...(p.side === 'payable' ? { side: 'payable' as const } : { side: 'receivable' as const }) } // i18n-technical
    case 'gstr3b':
      return { name: 'gstr3b', ...(str(p.month) ? { month: str(p.month)! } : {}) } // i18n-technical
    case 'trial-balance':
      return { name: 'trial-balance', ...(str(p.asOn) ? { asOn: str(p.asOn)! } : {}) } // i18n-technical
    default:
      return PLAIN.includes(t.screen) ? ({ name: t.screen } as Screen) : null
  }
}
