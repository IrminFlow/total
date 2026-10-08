// Small pieces shared by the Banking tabs (WP 4.1).
import { formatPaise } from '@shared/money'

/** Tables inside dialogs: quick filter, columns and count — no saved views, grouping, density
 *  or export in a modal. */
export const MODAL_TABLE_FEATURES = { groupBy: false, density: false, views: false, export: false } as const

export const DIRECTION_OPTIONS = [
  { value: 'deposit', label: 'Deposit' },
  { value: 'withdrawal', label: 'Withdrawal' }
]

/** Matching / suggestion settings from the Options drawer (screen options 'banking'). */
export interface MatchSettings {
  tolerancePaise: number
  dateWindowDays: number
  /** Proposals at or above this score are pre-selected for bulk confirm (0..1). */
  autoSelect: number
  /** Learned-rule suggestions below this score are not shown (0..1). */
  minSuggest: number
}

export const TOLERANCE_CHOICES = [
  { value: '0', label: 'Exact' },
  { value: '100', label: '±₹1' },
  { value: '1000', label: '±₹10' },
  { value: '10000', label: '±₹100' }
] as const
export const WINDOW_CHOICES = [
  { value: '3', label: '3 days' },
  { value: '5', label: '5 days' },
  { value: '7', label: '7 days' },
  { value: '15', label: '15 days' }
] as const
export const AUTOSELECT_CHOICES = [
  { value: '0.9', label: 'Very sure' },
  { value: '0.75', label: 'Sure' },
  { value: '0.6', label: 'Likely' }
] as const
export const SUGGEST_CHOICES = [
  { value: '0.6', label: 'Strong only' },
  { value: '0.4', label: 'Normal' },
  { value: '0.25', label: 'Any hint' }
] as const

export const rupees = (paise: number): string => formatPaise(paise, { symbol: true })

export const pct = (x: number): string => `${Math.round(x * 100)}%`

/** "Suggested from 12 earlier matches" / "From your rule". */
export function evidenceText(s: { source: 'learned' | 'rule'; evidence: number }): string {
  if (s.source === 'rule') return 'From your bank rule'
  return `Suggested from ${s.evidence} earlier ${s.evidence === 1 ? 'match' : 'matches'}`
}
