/**
 * Keyset ("seek") pagination: the cursor, the comparison, and the SQL predicate.
 *
 * Why not OFFSET. `LIMIT n OFFSET k` makes SQLite produce and discard k rows before it returns
 * one, so the last page of a long report costs the whole report. Measured on a 7,800-voucher
 * book the Day Book's first page took 33 ms and its last 52 ms, and that gap grows with the
 * book. Keyset pagination asks instead for "the rows after this one", which the index on the
 * sort key answers in the same time wherever the page falls.
 *
 * Why it is easy to get wrong. A cursor has to name a TOTAL order. Day Book rows are ordered by
 * date, and thousands of vouchers share a date; "everything after 2026-04-01" either repeats the
 * rest of that day or skips it. So every cursor here carries the full tuple the query orders by,
 * down to a unique column, and the comparison is lexicographic over that tuple. The tests that
 * matter are the ones at a page boundary with equal leading keys.
 *
 * Pure: no SQL is executed here and no database type is imported. The caller pastes `sql` into
 * its WHERE clause and spreads `params`.
 */

/** One column of a sort key. Strings compare as SQLite's BINARY collation does for ISO dates and
 *  ASCII; numbers compare numerically. Mixing types within one column is not supported. */
export type KeyValue = string | number

/** The values of the ordering columns for one row, in the same order as the ORDER BY. */
export type KeysetCursor = readonly KeyValue[]

/**
 * Lexicographic comparison of two sort keys: negative when `a` sorts first.
 *
 * Used by tests to prove a page boundary neither repeats nor skips a row, and by the renderer to
 * drop a row it already holds if a page is ever fetched twice.
 */
export function compareKeys(a: KeysetCursor, b: KeysetCursor): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    return String(x) < String(y) ? -1 : 1
  }
  return a.length - b.length
}

/**
 * The WHERE fragment selecting rows strictly after `cursor` in the order `columns` defines.
 *
 * Emitted as SQLite's row-value comparison — `(a, b, c) > (?, ?, ?)` — which is one expression
 * the query planner can drive an index from, rather than the hand-expanded OR-chain, which it
 * cannot. Row values have been in SQLite since 3.15 (2016); better-sqlite3 ships far newer.
 *
 * `columns` are SQL identifiers supplied by the calling service, never by a user: they are
 * interpolated, so they are validated here rather than trusted.
 */
export function keysetAfter(
  columns: readonly string[],
  cursor: KeysetCursor
): { sql: string; params: KeyValue[] } {
  return keysetCompare(columns, cursor, '>')
}

/**
 * The mirror of `keysetAfter`: everything up to and including the cursor.
 *
 * A paged running balance needs this. The balance on the first row of page four is opening plus
 * the movement of every row before it, and asking SQLite to SUM the rows at-or-before the cursor
 * is one aggregate — against re-reading and re-adding three pages of rows in JavaScript, which is
 * the cost keyset pagination exists to avoid.
 */
export function keysetAtOrBefore(
  columns: readonly string[],
  cursor: KeysetCursor
): { sql: string; params: KeyValue[] } {
  return keysetCompare(columns, cursor, '<=')
}

function keysetCompare(
  columns: readonly string[],
  cursor: KeysetCursor,
  op: '>' | '<='
): { sql: string; params: KeyValue[] } {
  if (columns.length === 0) throw new Error('keysetAfter: no ordering columns')
  if (columns.length !== cursor.length) {
    throw new Error(`keysetAfter: ${columns.length} columns but ${cursor.length} cursor values`)
  }
  for (const c of columns) {
    // Deliberately narrow: `table.column` and nothing else. A cursor is never worth an injection
    // surface, and every real caller in this codebase is exactly this shape.
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(c)) {
      throw new Error(`keysetAfter: unsafe ordering column ${JSON.stringify(c)}`)
    }
  }
  const cols = columns.join(', ')
  const holes = columns.map(() => '?').join(', ')
  // Parenthesised even for one column, where SQLite reads `(a) > (?)` as a plain comparison.
  return { sql: `(${cols}) ${op} (${holes})`, params: [...cursor] }
}

/** The ORDER BY matching a cursor built over `columns`. Kept beside `keysetAfter` because the two
 *  disagreeing is the bug that produces duplicated and skipped rows. */
export function keysetOrderBy(columns: readonly string[]): string {
  return columns.join(', ')
}

/**
 * A cursor as one opaque string, for crossing IPC and living in react-query keys.
 *
 * JSON inside base64url rather than a delimiter-joined string: a narration, a voucher number or
 * a party name can contain any character a delimiter might use, and a cursor that breaks on one
 * row in ten thousand is a bug found only on someone's real book.
 */
export function encodeCursor(cursor: KeysetCursor): string {
  const json = JSON.stringify(cursor)
  const b64 = typeof btoa === 'function' ? btoa(unescapeUtf8(json)) : Buffer.from(json, 'utf8').toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decodes what `encodeCursor` wrote. Returns null for anything malformed — a stale or hand-typed
 *  cursor should restart the list, never throw a screen away. */
export function decodeCursor(text: string | null | undefined): KeyValue[] | null {
  if (!text) return null
  try {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
    const json =
      typeof atob === 'function' ? escapeUtf8(atob(b64)) : Buffer.from(b64, 'base64').toString('utf8')
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    if (!parsed.every((v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))) return null
    return parsed as KeyValue[]
  } catch {
    return null
  }
}

// btoa/atob are byte-oriented; a company name with a rupee sign in a cursor would otherwise throw
// in the renderer and work in main. These two make both paths agree on UTF-8.
function unescapeUtf8(s: string): string {
  return String.fromCharCode(...new TextEncoder().encode(s))
}
function escapeUtf8(s: string): string {
  return new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0)))
}
