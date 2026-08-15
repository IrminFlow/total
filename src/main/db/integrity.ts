// Electron-free integrity check (dbtest-able; DB is opened by the caller with the Electron ABI).
import type { DB } from './connection'

export interface IntegrityResult {
  ok: boolean
  quickCheck: string
  unbalancedVoucherIds: number[]
}

/**
 * `PRAGMA quick_check` plus a per-voucher debit/credit balance check across ALL voucher_lines
 * (no deleted_at filter — binned vouchers must balance too). Returns up to 10 offending voucher
 * ids. `ok` is true only when quick_check reports 'ok' and no voucher is unbalanced.
 *
 * Never throws: on exactly the corruption this feature exists to detect, the balance query
 * itself can throw (e.g. SqliteError 'database disk image is malformed') reading real table
 * pages after quick_check already ran clean. That's reported as a failed check, not an
 * exception, so callers can always safely treat this as non-blocking.
 */
export function checkIntegrity(db: DB): IntegrityResult {
  const quickCheck = db.pragma('quick_check', { simple: true }) as string

  try {
    const rows = db
      .prepare(
        `SELECT voucher_id AS id
         FROM voucher_lines
         GROUP BY voucher_id
         HAVING SUM(CASE WHEN dr_cr = 'dr' THEN amount ELSE -amount END) <> 0
         LIMIT 10`
      )
      .all() as { id: number }[]
    const unbalancedVoucherIds = rows.map((r) => r.id)

    return {
      ok: quickCheck === 'ok' && unbalancedVoucherIds.length === 0,
      quickCheck,
      unbalancedVoucherIds
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, quickCheck: `error: ${message}`, unbalancedVoucherIds: [] }
  }
}
