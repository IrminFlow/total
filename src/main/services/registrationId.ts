import type { DB } from '../db/connection'

/**
 * The company's primary GST registration id (roadmap #108).
 *
 * Its own module, importing nothing but the DB type, because the four callers that need it —
 * vouchers, filings, the GSTR-1 snapshot and the masters — already sit in a web of imports that a
 * shared home in `registrations.ts` would close into a cycle. A module with no dependencies
 * cannot be part of one.
 *
 * Resolving to the primary rather than leaving NULL is load-bearing wherever the answer reaches a
 * UNIQUE index: SQLite treats NULLs as distinct, so a NULL registration in `gst_filings` or
 * `gstr1_filed_documents` would silently insert a second row instead of updating the first.
 */
export function primaryRegistrationId(db: DB): number | null {
  const row = db
    .prepare('SELECT id FROM gst_registrations ORDER BY is_primary DESC, id LIMIT 1')
    .get() as { id: number } | undefined
  return row?.id ?? null
}
