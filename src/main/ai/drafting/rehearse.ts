// WP 5.3 — validating a draft EXACTLY as its save would, without writing anything.
//
// A draft tool builds the payload the editor will post (through the editor's own shared mapping)
// and then rehearses the real save — saveVoucher / saveManufacture / saveTradeDoc — inside a
// transaction that is ALWAYS rolled back. So every rule the save enforces (Zod schema,
// validateVoucher, lock date, credit hold, closing-journal immutability, trade-link rules I1–I7,
// TDS / TCS checks, negative-stock blocks, manufacture rules) is reported back to the model as a
// validation error, never bypassed — and nothing persists: no voucher, no ledger the editor would
// create on first use, no audit row (audit_log is append-only *after* commit; a rolled-back row
// never existed). No tool writes the books.
import type { DB } from '../../db/connection'

class RehearsalDone extends Error {
  constructor() {
    super('rehearsal rolled back')
  }
}

/** Run `fn` in a transaction and roll it back, returning what `fn` returned. Errors from `fn`
 *  (the save's validation) propagate unchanged. */
export function rehearse<T>(db: DB, fn: () => T): T {
  let out: { v: T } | null = null
  try {
    db.transaction(() => {
      out = { v: fn() }
      throw new RehearsalDone()
    })()
  } catch (err) {
    if (!(err instanceof RehearsalDone)) throw err
  }
  return (out as { v: T } | null)!.v
}
