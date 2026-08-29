import type { Statement } from 'better-sqlite3'
import type { DB } from './connection'

/**
 * A per-connection prepared-statement cache for the hot write path (roadmap K#228).
 *
 * `db.prepare()` compiles SQL. Measured on the shared 900-invoice fixture, one compile costs
 * 2–7 µs and `saveVoucher` does 26 of them — 233 µs of a 754 µs save, which is 31% of the write
 * path spent re-compiling the same twenty-six strings the app has compiled on every save since it
 * was installed. Reports were measured too and are not worth it: `trialBalance` spends 0.7% of
 * its time preparing, so nothing here is used by them.
 *
 * ## Why this is opt-in and not a patched `db.prepare`
 *
 * Wrapping the connection would have cached every statement in the app for free, and it would
 * have been wrong. A better-sqlite3 `Statement` carries mutable state: `.pluck()`, `.raw()` and
 * `.expand()` are sticky, and a statement in the middle of `.iterate()` throws if it is run
 * again. Sharing one between two callers turns any of those into a bug that appears only when
 * two features are used in the same session. Nothing in `src/main` uses those methods today, but
 * "today" is not a guarantee anybody can see from the call site.
 *
 * So the cache is a function a caller reaches for deliberately, with two rules:
 *
 *   1. **The SQL must be a literal constant.** A string built per call (`IN (${placeholders})`,
 *      an optional WHERE clause) would put an unbounded number of statements in the map, which
 *      is a leak wearing a cache's clothes. `stmt.test.ts` checks every call site.
 *   2. **No `.pluck()`, `.raw()`, `.expand()` or `.iterate()` on the result.** Same test.
 *
 * The map is keyed off the connection through a WeakMap, so closing a company drops its
 * statements with it, and a restore that swaps the file underneath gets a fresh connection and
 * therefore a fresh cache. SQLite re-prepares automatically across a schema change, so a
 * migration cannot leave a stale statement behind either.
 */
const caches = new WeakMap<DB, Map<string, Statement>>()

/** The cached `Statement` for `sql` on this connection, compiling it the first time only. */
export function prep(db: DB, sql: string): Statement {
  let cache = caches.get(db)
  if (!cache) {
    cache = new Map()
    caches.set(db, cache)
  }
  const hit = cache.get(sql)
  if (hit) return hit
  const stmt = db.prepare(sql)
  cache.set(sql, stmt)
  return stmt
}

/** Statements held for this connection. Test-only — the cache is otherwise invisible. */
export function preparedCount(db: DB): number {
  return caches.get(db)?.size ?? 0
}

/** Drop this connection's cache. Test-only: it is what lets a benchmark run the same code with
 *  and without the cache inside one process, which is the only way to compare the two on a
 *  machine that is doing other things. */
export function clearPrepared(db: DB): void {
  caches.get(db)?.clear()
}
