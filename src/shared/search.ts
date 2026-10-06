import type { VoucherKind } from './domain'
import type { SearchChip, SearchKind } from './searchQuery'

/** A single global-search result (legacy `search:global` shape, kept for API compatibility). */
export interface SearchHit {
  kind: 'ledger' | 'item' | 'voucher'
  id: number
  label: string
  sub: string
}

/** Escapes `%` and `_` (SQLite LIKE wildcards) so a raw search string can be embedded safely in a
 *  `LIKE '%'||?||'%' ESCAPE '\'` clause. Callers append the surrounding `%` wildcards themselves. */
export function escapeLike(q: string): string {
  return q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/** The field a result matched on — drives the "matched in …" hint and highlighting. */
export type LedgerMatchField = 'name' | 'group' | 'gstin' | 'pan' | 'address' | 'state' | 'hsn'
export type ItemMatchField = 'name' | 'hsn' | 'barcode' | 'group'
export type VoucherMatchField =
  | 'number' | 'narration' | 'reference' | 'party' | 'ledger' | 'item' | 'amount' | 'gstin' | 'pan'
  | 'type' | 'date' | 'hsn' | 'group'

export interface LedgerResult {
  kind: 'ledger'
  id: number
  name: string
  groupName: string
  gstin: string | null
  pan: string | null
  matchField: LedgerMatchField | null
  /** The matched field's value (e.g. the ancestor group name or the GSTIN). */
  matchText: string | null
}

export interface ItemResult {
  kind: 'item'
  id: number
  name: string
  hsn: string | null
  barcode: string | null
  groupName: string | null
  matchField: ItemMatchField | null
  matchText: string | null
}

export interface VoucherResult {
  kind: 'voucher'
  id: number
  /** Voucher type name ("Sales", or a custom "Sales GST"). */
  typeName: string
  voucherKind: VoucherKind
  number: string
  date: string
  /** Main party ledger when the voucher has one, else its first ledger line. */
  party: string | null
  /** Voucher total in paise (sum of debit lines). */
  amount: number
  /** Narration trimmed to a short window around the match. */
  narration: string | null
  isOptional: boolean
  postDated: boolean
  matchField: VoucherMatchField | null
  matchText: string | null
}

export type SearchResult = LedgerResult | ItemResult | VoucherResult

export interface SearchSection<T> {
  rows: T[]
  /** Total matches for this kind (for "showing 20 of 312"). */
  total: number
  offset: number
}

export interface SearchResponse {
  chips: SearchChip[]
  unknown: string[]
  /** Free-text terms (lower-cased) — what the UI highlights. */
  terms: string[]
  /** Kinds this query can match at all (after `in:` and field applicability). */
  kinds: SearchKind[]
  /** null when the request was restricted to another kind (`kind` option). */
  ledgers: SearchSection<LedgerResult> | null
  items: SearchSection<ItemResult> | null
  vouchers: SearchSection<VoucherResult> | null
}
