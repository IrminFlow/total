/** A single global-search result (⌘K "In your books" section). */
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
