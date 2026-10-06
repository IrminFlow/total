import { useCallback } from 'react'
import { useNav, useSession } from '../state/stores'
import { rememberQuery, rememberRecord, type RecentKind, type RecentRecord } from '../lib/searchRecents'
import { highlightSegments, type SearchChip, type SearchKind } from '@shared/searchQuery'
import type { SearchResult, VoucherResult } from '@shared/search'
import { toDisplayDate } from '@shared/dates'

/** Shared bits of the ⌘K palette and the Search results screen. */

export const KIND_TITLE: Record<SearchKind, string> = { ledger: 'Ledgers', item: 'Stock items', voucher: 'Vouchers' }
export const KIND_SINGULAR: Record<SearchKind, string> = { ledger: 'Ledger', item: 'Item', voucher: 'Voucher' }

/** The syntax cheat-sheet shown under an empty palette and on the results screen. */
export const SYNTAX_HINTS: { token: string; label: string }[] = [
  { token: 'amt:>50000', label: 'amount' },
  { token: 'date:apr', label: 'month' },
  { token: 'fy:2026', label: 'year' },
  { token: 'type:sales', label: 'voucher type' },
  { token: 'gstin:27AAP', label: 'GSTIN' },
  { token: 'party:acme', label: 'party' },
  { token: 'group:sundry', label: 'group' },
  { token: 'in:vouchers', label: 'kind' },
  { token: '"exact phrase"', label: 'phrase' }
]

/** `text` with the query's free-text terms marked. */
export function Highlight({ text, terms }: { text: string; terms: string[] }): React.JSX.Element {
  const segs = highlightSegments(text, terms)
  return (
    <>
      {segs.map((s, i) =>
        s.match ? (
          <mark key={i} className="rounded-sm bg-amber/25 px-px text-ink">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
    </>
  )
}

/** Parsed-filter chips (+ tokens that weren't understood). `onRemove` adds a ✕ per chip. */
export function QueryChips({
  chips,
  unknown,
  onRemove,
  testId = 'search-chips'
}: {
  chips: SearchChip[]
  unknown: string[]
  onRemove?: (raw: string) => void
  testId?: string
}): React.JSX.Element | null {
  if (chips.length === 0 && unknown.length === 0) return null
  return (
    <div data-testid={testId} className="flex flex-wrap items-center gap-1.5">
      {chips.map((c, i) => (
        <span
          key={`${c.raw}-${i}`}
          data-chip={c.key}
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] ${
            c.key === 'bare-amount' ? 'border-line text-muted' : 'border-amber/40 bg-amber/10 text-ink'
          }`}
        >
          {c.label}
          {onRemove && (
            <button
              type="button"
              aria-label={`Remove ${c.label}`}
              className="-mr-0.5 rounded-full px-0.5 text-muted hover:text-ink"
              onClick={() => onRemove(c.raw)}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {unknown.length > 0 && (
        <span data-chip="unknown" className="text-[11.5px] text-muted" title="Searched as plain text">
          Not a filter: {unknown.join(', ')}
        </span>
      )}
    </div>
  )
}

const LEDGER_MATCH: Record<string, string> = { gstin: 'GSTIN', pan: 'PAN', group: 'Group', address: 'Address', state: 'State', hsn: 'HSN/SAC' }
const ITEM_MATCH: Record<string, string> = { hsn: 'HSN', barcode: 'Barcode', group: 'Group' }
const VOUCHER_MATCH: Record<string, string> = {
  reference: 'Ref', ledger: 'Ledger', item: 'Item', amount: 'Amount', gstin: 'GSTIN', pan: 'PAN', hsn: 'HSN', group: 'Group'
}

/** "GSTIN 27AAB…" — the matched field when it isn't already visible in the row's main text. */
export function matchHint(r: SearchResult): string | null {
  if (!r.matchField || !r.matchText) return null
  const map = r.kind === 'ledger' ? LEDGER_MATCH : r.kind === 'item' ? ITEM_MATCH : VOUCHER_MATCH
  const label = map[r.matchField]
  return label ? `${label}: ${r.matchText}` : null
}

export function voucherTitle(v: VoucherResult): string {
  return `${v.typeName} ${v.number}`
}

export function resultLabel(r: SearchResult): string {
  return r.kind === 'voucher' ? voucherTitle(r) : r.name
}

export function recentRecordFor(r: SearchResult): RecentRecord {
  if (r.kind === 'ledger') return { id: r.id, label: r.name, sub: r.groupName }
  if (r.kind === 'item') return { id: r.id, label: r.name, sub: r.groupName ?? 'Stock item' }
  return { id: r.id, label: voucherTitle(r), sub: [toDisplayDate(r.date), r.party].filter(Boolean).join(' · ') }
}

/** Badges for vouchers outside the books (same styling as the Day Book). */
export function VoucherBadges({ v }: { v: Pick<VoucherResult, 'isOptional' | 'postDated'> }): React.JSX.Element | null {
  if (!v.isOptional && !v.postDated) return null
  return (
    <>
      {v.isOptional && <span className="ml-2 rounded bg-amber/15 px-1.5 py-0.5 text-[10px] font-medium text-amber">Optional</span>}
      {v.postDated && <span className="ml-2 rounded bg-blue/10 px-1.5 py-0.5 text-[10px] font-medium text-blue">PDC</span>}
    </>
  )
}

/** Navigate to a search result / recent record, remembering it (and the query) as recent.
 *  ledger → ledger statement; item → its editor in Masters › Stock items; voucher → entry. */
export function useOpenRecord(): (kind: RecentKind, rec: RecentRecord, query?: string) => void {
  const nav = useNav()
  return useCallback(
    (kind, rec, query) => {
      const slug = useSession.getState().slug
      if (query) rememberQuery(slug, query)
      rememberRecord(slug, kind, rec)
      if (kind === 'ledger') nav.go({ name: 'ledger-statement', ledgerId: rec.id })
      else if (kind === 'item') nav.go({ name: 'masters', tab: 'items', itemId: rec.id })
      else nav.go({ name: 'voucher-entry', voucherId: rec.id })
    },
    [nav]
  )
}
